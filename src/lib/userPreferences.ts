import type { D1Database } from '../types';

export interface NotificationPreferences {
  tripReminders: boolean;
  tripUpdates: boolean;
  marketingEmails: boolean;
  smsNotifications: boolean;
}

export interface PrivacyPreferences {
  shareLocation: boolean;
  allowDriverContact: boolean;
  showInDirectory: boolean;
}

export interface AccessibilityPreferences {
  wheelchairAccessible: boolean;
  visualImpairment: boolean;
  hearingImpairment: boolean;
}

export interface UserPreferences {
  notifications: NotificationPreferences;
  privacy: PrivacyPreferences;
  accessibility: AccessibilityPreferences;
  language: string;
  timezone: string;
  currency: string;
}

interface UserPreferencesRow {
  notifications_json: string;
  privacy_json: string;
  accessibility_json: string;
  language: string;
  timezone: string;
  currency: string;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  notifications: {
    tripReminders: true,
    tripUpdates: true,
    marketingEmails: false,
    smsNotifications: true,
  },
  privacy: {
    shareLocation: true,
    allowDriverContact: true,
    showInDirectory: false,
  },
  accessibility: {
    wheelchairAccessible: false,
    visualImpairment: false,
    hearingImpairment: false,
  },
  language: 'en',
  timezone: 'Africa/Johannesburg',
  currency: 'ZAR',
};

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

export function normalizePreferences(input: Partial<UserPreferences> | null | undefined): UserPreferences {
  const notifications = (input?.notifications || {}) as Record<string, unknown>;
  const privacy = (input?.privacy || {}) as Record<string, unknown>;
  const accessibility = (input?.accessibility || {}) as Record<string, unknown>;

  return {
    notifications: {
      tripReminders: boolOrDefault(notifications.tripReminders, DEFAULT_USER_PREFERENCES.notifications.tripReminders),
      tripUpdates: boolOrDefault(notifications.tripUpdates, DEFAULT_USER_PREFERENCES.notifications.tripUpdates),
      marketingEmails: boolOrDefault(notifications.marketingEmails, DEFAULT_USER_PREFERENCES.notifications.marketingEmails),
      smsNotifications: boolOrDefault(notifications.smsNotifications, DEFAULT_USER_PREFERENCES.notifications.smsNotifications),
    },
    privacy: {
      shareLocation: boolOrDefault(privacy.shareLocation, DEFAULT_USER_PREFERENCES.privacy.shareLocation),
      allowDriverContact: boolOrDefault(privacy.allowDriverContact, DEFAULT_USER_PREFERENCES.privacy.allowDriverContact),
      showInDirectory: boolOrDefault(privacy.showInDirectory, DEFAULT_USER_PREFERENCES.privacy.showInDirectory),
    },
    accessibility: {
      wheelchairAccessible: boolOrDefault(accessibility.wheelchairAccessible, DEFAULT_USER_PREFERENCES.accessibility.wheelchairAccessible),
      visualImpairment: boolOrDefault(accessibility.visualImpairment, DEFAULT_USER_PREFERENCES.accessibility.visualImpairment),
      hearingImpairment: boolOrDefault(accessibility.hearingImpairment, DEFAULT_USER_PREFERENCES.accessibility.hearingImpairment),
    },
    language: strOrDefault(input?.language, DEFAULT_USER_PREFERENCES.language),
    timezone: strOrDefault(input?.timezone, DEFAULT_USER_PREFERENCES.timezone),
    currency: strOrDefault(input?.currency, DEFAULT_USER_PREFERENCES.currency),
  };
}

export async function getUserPreferences(db: D1Database, userId: number): Promise<UserPreferences> {
  try {
    const row = await db.prepare(`
      SELECT notifications_json, privacy_json, accessibility_json, language, timezone, currency
      FROM user_preferences
      WHERE user_id = ?
    `).bind(userId).first<UserPreferencesRow>();

    if (!row) return DEFAULT_USER_PREFERENCES;

    return normalizePreferences({
      notifications: parseJsonObject(row.notifications_json) as unknown as NotificationPreferences,
      privacy: parseJsonObject(row.privacy_json) as unknown as PrivacyPreferences,
      accessibility: parseJsonObject(row.accessibility_json) as unknown as AccessibilityPreferences,
      language: row.language,
      timezone: row.timezone,
      currency: row.currency,
    });
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export async function upsertUserPreferences(db: D1Database, userId: number, input: Partial<UserPreferences>): Promise<UserPreferences> {
  const merged = normalizePreferences({
    ...(await getUserPreferences(db, userId)),
    ...input,
  });

  await db.prepare(`
    INSERT INTO user_preferences (
      user_id, notifications_json, privacy_json, accessibility_json, language, timezone, currency
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      notifications_json = excluded.notifications_json,
      privacy_json = excluded.privacy_json,
      accessibility_json = excluded.accessibility_json,
      language = excluded.language,
      timezone = excluded.timezone,
      currency = excluded.currency,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    userId,
    JSON.stringify(merged.notifications),
    JSON.stringify(merged.privacy),
    JSON.stringify(merged.accessibility),
    merged.language,
    merged.timezone,
    merged.currency,
  ).run();

  return merged;
}

export async function getUserNotificationPreferences(db: D1Database, userId: number): Promise<NotificationPreferences> {
  const prefs = await getUserPreferences(db, userId);
  return prefs.notifications;
}
