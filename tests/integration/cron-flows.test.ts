import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Bindings } from '../../src/types';

type ResolverKind = 'first' | 'all' | 'run';
type Resolver = (query: string, params: unknown[], kind: ResolverKind) => unknown;

class MockStmt {
  private params: unknown[] = [];

  constructor(
    private query: string,
    private resolver: Resolver,
  ) {}

  bind(...values: unknown[]) {
    this.params = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const result = this.resolver(this.query, this.params, 'first');
    return (result ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ success: boolean; results?: T[] }> {
    const result = this.resolver(this.query, this.params, 'all');
    return { success: true, results: (result as T[]) ?? [] };
  }

  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
    const result = this.resolver(this.query, this.params, 'run');
    return { success: true, meta: (result as Record<string, unknown>) ?? { changes: 1 } };
  }
}

class MockDB {
  constructor(private resolver: Resolver) {}

  prepare(query: string) {
    return new MockStmt(query, this.resolver);
  }
}

class MockKV {
  public store = new Map<string, string>();
  public puts: Array<{ key: string; value: string; expirationTtl?: number }> = [];
  public gets: string[] = [];

  async get(key: string): Promise<string | null> {
    this.gets.push(key);
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, expirationTtl: opts?.expirationTtl });
    this.store.set(key, value);
  }
}

const {
  createRiderRequestMock,
  findCandidateDriversMock,
  saveMatchResultMock,
  updateRiderRequestStatusMock,
  matchRiderToDriversMock,
  sendPushNotificationMock,
  sendEmailMock,
  loggerInfoMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  createRiderRequestMock: vi.fn(),
  findCandidateDriversMock: vi.fn(),
  saveMatchResultMock: vi.fn(),
  updateRiderRequestStatusMock: vi.fn(),
  matchRiderToDriversMock: vi.fn(),
  sendPushNotificationMock: vi.fn(),
  sendEmailMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}));

vi.mock('../../src/lib/matching', () => {
  class MatchingRepository {
    constructor(_db: unknown, _kv?: unknown) {}

    createRiderRequest = createRiderRequestMock;
    findCandidateDrivers = findCandidateDriversMock;
    saveMatchResult = saveMatchResultMock;
    updateRiderRequestStatus = updateRiderRequestStatusMock;
  }

  return {
    MatchingRepository,
    matchRiderToDrivers: matchRiderToDriversMock,
    DEFAULT_MATCH_CONFIG: {},
  };
});

vi.mock('../../src/lib/push', () => ({
  sendPushNotification: sendPushNotificationMock,
}));

vi.mock('../../src/integrations/notifications', () => {
  class NotificationService {
    constructor(_env: unknown) {}

    async sendEmail(...args: unknown[]) {
      return sendEmailMock(...args);
    }
  }

  return { NotificationService };
});

import { batchMatchSubscriptionDays, sendTripReminders } from '../../src/lib/cron';

function makeEnv(db?: MockDB, cache?: MockKV): Bindings {
  return {
    DB: db,
    CACHE: cache,
  } as unknown as Bindings;
}

function makeScheduledDay(partial: Partial<Record<string, unknown>> = {}) {
  return {
    id: 9,
    subscription_id: 1,
    user_id: 44,
    trip_date: '2026-02-25',
    trip_type: 'morning',
    departure_time: '07:30',
    pickup_lat: -26.2,
    pickup_lng: 28.04,
    dropoff_lat: -26.1,
    dropoff_lng: 28.03,
    status: 'scheduled',
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  createRiderRequestMock.mockImplementation(async (id: string, riderId: number, payload: Record<string, unknown>) => ({
    id,
    riderId: String(riderId),
    ...payload,
  }));
  findCandidateDriversMock.mockResolvedValue([{ id: 'candidate-1' }]);
  matchRiderToDriversMock.mockReturnValue({
    matches: [{ driverTripId: 'driver-trip-1', riderRequestId: 'subday:9' }],
  });
});

describe('batchMatchSubscriptionDays', () => {
  test('returns early when env.DB is undefined', async () => {
    await batchMatchSubscriptionDays(makeEnv(undefined, new MockKV()));
    expect(createRiderRequestMock).not.toHaveBeenCalled();
  });

  test('skips when query returns empty days', async () => {
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM monthly_scheduled_days') && kind === 'all') return [];
      return null;
    });

    await batchMatchSubscriptionDays(makeEnv(db, new MockKV()));
    expect(createRiderRequestMock).not.toHaveBeenCalled();
    expect(saveMatchResultMock).not.toHaveBeenCalled();
  });

  test('skips days with null coordinates but still marks requested', async () => {
    const runCalls: Array<{ query: string; params: unknown[] }> = [];
    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM monthly_scheduled_days') && kind === 'all') {
        return [makeScheduledDay({ pickup_lat: null })];
      }
      if (kind === 'run') {
        runCalls.push({ query, params: [...params] });
      }
      return null;
    });

    await batchMatchSubscriptionDays(makeEnv(db, new MockKV()));
    expect(runCalls.some((call) => call.query.includes("SET status = 'requested'"))).toBe(true);
    expect(createRiderRequestMock).not.toHaveBeenCalled();
  });

  test('skips days with invalid departure_time string and logs warning', async () => {
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM monthly_scheduled_days') && kind === 'all') {
        return [makeScheduledDay({ departure_time: 'invalid-time' })];
      }
      return null;
    });

    await batchMatchSubscriptionDays(makeEnv(db, new MockKV()));
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'batchMatchSubscriptionDays: invalid departure time',
      expect.any(Object),
    );
    expect(createRiderRequestMock).not.toHaveBeenCalled();
  });

  test('calls saveMatchResult and sets status matched when candidates exist', async () => {
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM monthly_scheduled_days') && kind === 'all') {
        return [makeScheduledDay()];
      }
      if (query.includes('FROM driver_trips dt') && kind === 'first') return { id: 42 };
      return null;
    });

    await batchMatchSubscriptionDays(makeEnv(db, new MockKV()));
    expect(saveMatchResultMock).toHaveBeenCalledTimes(1);
    expect(updateRiderRequestStatusMock).toHaveBeenCalledWith('subday:9', 'matched', 'driver-trip-1');
  });

  test('persists trip_id when correlation query finds a trips row', async () => {
    const runCalls: Array<{ query: string; params: unknown[] }> = [];
    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM monthly_scheduled_days') && kind === 'all') {
        return [makeScheduledDay()];
      }
      if (query.includes('FROM driver_trips dt') && kind === 'first') return { id: 42 };
      if (kind === 'run') {
        runCalls.push({ query, params: [...params] });
      }
      return null;
    });

    await batchMatchSubscriptionDays(makeEnv(db, new MockKV()));
    const matchedWrite = runCalls.find((call) => call.query.includes("SET status = 'matched', trip_id = ?"));
    expect(matchedWrite).toBeDefined();
    expect(matchedWrite?.params[0]).toBe(42);
  });

  test('sets trip_id null when correlation query returns nothing', async () => {
    const runCalls: Array<{ query: string; params: unknown[] }> = [];
    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM monthly_scheduled_days') && kind === 'all') {
        return [makeScheduledDay()];
      }
      if (query.includes('FROM driver_trips dt') && kind === 'first') return null;
      if (kind === 'run') {
        runCalls.push({ query, params: [...params] });
      }
      return null;
    });

    await batchMatchSubscriptionDays(makeEnv(db, new MockKV()));
    const matchedWrite = runCalls.find((call) => call.query.includes("SET status = 'matched', trip_id = ?"));
    expect(matchedWrite?.params[0]).toBeNull();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'batchMatchSubscriptionDays: matched trip correlation not found',
      expect.any(Object),
    );
  });
});

describe('sendTripReminders', () => {
  test('returns early when DB undefined', async () => {
    await sendTripReminders(makeEnv(undefined, new MockKV()), '24h');
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
  });

  test('returns early when CACHE undefined', async () => {
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips t') && kind === 'all') {
        return [{ id: 1, rider_id: 10, rider_email: 'rider@example.com', departure_time: '2026-02-26T08:00:00.000Z' }];
      }
      return null;
    });

    await sendTripReminders(makeEnv(db, undefined), '24h');
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'sendTripReminders: CACHE KV not available — skipping to prevent duplicate notifications',
    );
  });

  test('no-ops when no trips are in the window', async () => {
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips t') && kind === 'all') return [];
      return null;
    });

    await sendTripReminders(makeEnv(db, new MockKV()), '24h');
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  test('skips already-cached trips (dedup key hit)', async () => {
    const cache = new MockKV();
    cache.store.set('reminder:7:21:24h', '1');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips t') && kind === 'all') {
        return [{ id: 7, rider_id: 21, rider_email: 'rider@example.com', departure_time: '2026-02-26T08:00:00.000Z' }];
      }
      return null;
    });

    await sendTripReminders(makeEnv(db, cache), '24h');
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(cache.puts.length).toBe(0);
  });

  test('calls notification service and sets CACHE key for unseen trips', async () => {
    const cache = new MockKV();
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips t') && kind === 'all') {
        return [{ id: 8, rider_id: 25, rider_email: 'rider@example.com', departure_time: '2026-02-26T08:00:00.000Z' }];
      }
      return null;
    });

    await sendTripReminders(makeEnv(db, cache), '24h');
    expect(sendPushNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(cache.puts[0]?.key).toBe('reminder:8:25:24h');
  });

  test("works for the '24h' window", async () => {
    const cache = new MockKV();
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips t') && kind === 'all') {
        return [{ id: 11, rider_id: 28, rider_email: 'rider@example.com', departure_time: '2026-02-26T08:00:00.000Z' }];
      }
      return null;
    });

    await sendTripReminders(makeEnv(db, cache), '24h');
    expect(cache.puts[0]?.key.endsWith(':24h')).toBe(true);
    expect(sendPushNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      28,
      expect.objectContaining({
        body: expect.stringContaining('24 hours'),
      }),
    );
  });

  test("works for the '1h' window", async () => {
    const cache = new MockKV();
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips t') && kind === 'all') {
        return [{ id: 12, rider_id: 29, rider_email: 'rider@example.com', departure_time: '2026-02-25T09:00:00.000Z' }];
      }
      return null;
    });

    await sendTripReminders(makeEnv(db, cache), '1h');
    expect(cache.puts[0]?.key.endsWith(':1h')).toBe(true);
    expect(sendPushNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      29,
      expect.objectContaining({
        body: expect.stringContaining('1 hour'),
      }),
    );
  });
});
