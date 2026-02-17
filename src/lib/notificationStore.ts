import type { D1Database } from '../types';

export type NotificationType =
  | 'booking_request'
  | 'booking_accepted'
  | 'booking_rejected'
  | 'trip_cancelled'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'system';

export type NotificationChannel = 'in_app' | 'email' | 'sms' | 'push';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'read';

export interface CreateNotificationInput {
  userId: number;
  tripId?: number | null;
  notificationType: NotificationType;
  channel?: NotificationChannel;
  status?: NotificationStatus;
  subject?: string | null;
  message: string;
  metadata?: Record<string, unknown> | null;
}

export async function createNotification(db: D1Database, input: CreateNotificationInput): Promise<void> {
  const channel = input.channel ?? 'in_app';
  const status = input.status ?? 'pending';
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

  await db.prepare(`
    INSERT INTO notifications (
      user_id, trip_id, notification_type, channel, status, subject, message, metadata, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.userId,
    input.tripId ?? null,
    input.notificationType,
    channel,
    status,
    input.subject ?? null,
    input.message,
    metadata,
    status === 'pending' ? null : new Date().toISOString(),
  ).run();
}
