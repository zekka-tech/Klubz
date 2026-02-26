/**
 * Klubz - Event Bus for SSE
 *
 * In-memory pub/sub event bus that feeds connected SSE clients.
 * Events are published from route handlers and fanned out to subscribers.
 */
import type { AuthUser } from '../types';

export type EventType =
  | 'trip:created'
  | 'trip:updated'
  | 'trip:cancelled'
  | 'trip:completed'
  | 'trip:arrived'
  | 'booking:requested'
  | 'booking:accepted'
  | 'booking:cancelled'
  | 'booking:rejected'
  | 'new_message'
  | 'waitlist:promoted'
  | 'match:found'
  | 'match:confirmed'
  | 'match:rejected'
  | 'pool:assigned'
  | 'payment:succeeded'
  | 'payment:failed'
  | 'location:update'
  | 'system:alert';

export interface AppEvent {
  type: EventType;
  userId?: number;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Non-admin users must only receive events explicitly targeted at their user id.
 * Admin and super_admin roles can observe the full event stream.
 */
export function isEventVisibleToUser(event: AppEvent, user: Pick<AuthUser, 'id' | 'role'>): boolean {
  if (user.role === 'admin' || user.role === 'super_admin') {
    return true;
  }
  return event.userId !== undefined && event.userId === user.id;
}

type Subscriber = (event: AppEvent) => void;

class EventBus {
  private subscribers = new Map<string, Set<Subscriber>>();
  private globalSubscribers = new Set<Subscriber>();

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on(type: EventType, fn: Subscriber): () => void {
    if (!this.subscribers.has(type)) {
      this.subscribers.set(type, new Set());
    }
    this.subscribers.get(type)!.add(fn);
    return () => { this.subscribers.get(type)?.delete(fn); };
  }

  /** Subscribe to ALL events. Returns unsubscribe function. */
  onAll(fn: Subscriber): () => void {
    this.globalSubscribers.add(fn);
    return () => { this.globalSubscribers.delete(fn); };
  }

  /** Publish an event to all matching subscribers. */
  emit(type: EventType, data: Record<string, unknown>, userId?: number) {
    const event: AppEvent = {
      type,
      userId,
      data,
      timestamp: new Date().toISOString(),
    };

    // Type-specific subscribers
    const subs = this.subscribers.get(type);
    if (subs) {
      for (const fn of subs) {
        try { fn(event); } catch { /* subscriber error shouldn't crash bus */ }
      }
    }

    // Global subscribers (SSE connections)
    for (const fn of this.globalSubscribers) {
      try { fn(event); } catch { /* ignore */ }
    }
  }

  /** Get count of active subscribers (for monitoring). */
  get subscriberCount(): number {
    let count = this.globalSubscribers.size;
    for (const subs of this.subscribers.values()) {
      count += subs.size;
    }
    return count;
  }
}

/** Singleton event bus — shared across all route handlers. */
export const eventBus = new EventBus();
