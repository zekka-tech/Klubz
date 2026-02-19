import { describe, expect, test } from 'vitest';
import { isEventVisibleToUser, type AppEvent } from '../../src/lib/eventBus';

const baseEvent: AppEvent = {
  type: 'booking:accepted',
  userId: 10,
  data: { bookingId: 42 },
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('event bus visibility', () => {
  test('allows a regular user to view their own user-scoped event', () => {
    expect(isEventVisibleToUser(baseEvent, { id: 10, role: 'user' })).toBe(true);
  });

  test('blocks a regular user from viewing another user event', () => {
    expect(isEventVisibleToUser(baseEvent, { id: 11, role: 'user' })).toBe(false);
  });

  test('blocks regular users from viewing unscoped global events', () => {
    const globalEvent: AppEvent = {
      ...baseEvent,
      userId: undefined,
      type: 'trip:created',
    };
    expect(isEventVisibleToUser(globalEvent, { id: 10, role: 'user' })).toBe(false);
  });

  test('allows admin and super_admin users to view all events', () => {
    const globalEvent: AppEvent = {
      ...baseEvent,
      userId: undefined,
      type: 'system:alert',
    };
    expect(isEventVisibleToUser(globalEvent, { id: 1, role: 'admin' })).toBe(true);
    expect(isEventVisibleToUser(baseEvent, { id: 2, role: 'super_admin' })).toBe(true);
  });
});
