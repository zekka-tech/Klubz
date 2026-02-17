/**
 * Klubz - Notification Service (Twilio SMS + SendGrid Email)
 *
 * Workers-compatible HTTP-based integrations (no Node SDKs).
 */

import type { Bindings } from '../types';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// SMS via Twilio
// ---------------------------------------------------------------------------

export class TwilioService {
  private accountSid: string;
  private authToken: string;
  private fromNumber: string;

  constructor(accountSid: string, authToken: string, fromNumber: string) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fromNumber = fromNumber;
  }

  async sendSMS(to: string, body: string): Promise<{ sid: string; status: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = btoa(`${this.accountSid}:${this.authToken}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: this.fromNumber,
        Body: body,
      }).toString(),
    });

    const data = await response.json() as { sid: string; status: string; message?: string };
    if (!response.ok) {
      throw new Error(`Twilio error: ${data.message || response.statusText}`);
    }

    logger.info('SMS sent', { to: to.slice(-4), sid: data.sid });
    return { sid: data.sid, status: data.status };
  }
}

// ---------------------------------------------------------------------------
// Email via SendGrid
// ---------------------------------------------------------------------------

export class SendGridService {
  private apiKey: string;
  private fromEmail: string;
  private fromName: string;

  constructor(apiKey: string, fromEmail = 'noreply@klubz.com', fromName = 'Klubz') {
    this.apiKey = apiKey;
    this.fromEmail = fromEmail;
    this.fromName = fromName;
  }

  async sendEmail(params: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<void> {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: params.to }] }],
        from: { email: this.fromEmail, name: this.fromName },
        subject: params.subject,
        content: [
          ...(params.text ? [{ type: 'text/plain', value: params.text }] : []),
          { type: 'text/html', value: params.html },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SendGrid error: ${text}`);
    }

    logger.info('Email sent', { to: params.to, subject: params.subject });
  }

  /** Send a templated verification email. */
  async sendVerificationEmail(to: string, name: string, verificationUrl: string) {
    await this.sendEmail({
      to,
      subject: 'Verify your Klubz account',
      html: `
        <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
          <h1 style="color:#3B82F6">Welcome to Klubz, ${name}!</h1>
          <p>Please verify your email address to get started with smart carpooling.</p>
          <a href="${verificationUrl}" style="display:inline-block;background:#3B82F6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Verify Email</a>
          <p style="color:#6B7280;font-size:0.875rem;margin-top:20px">If you didn't create this account, please ignore this email.</p>
        </div>
      `,
      text: `Welcome to Klubz, ${name}! Verify your email: ${verificationUrl}`,
    });
  }

  /** Send trip booking confirmation. */
  async sendBookingConfirmation(to: string, name: string, tripDetails: {
    driverName: string;
    pickup: string;
    dropoff: string;
    time: string;
    price: string;
  }) {
    await this.sendEmail({
      to,
      subject: 'Trip Booking Confirmed - Klubz',
      html: `
        <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
          <h1 style="color:#3B82F6">Booking Confirmed!</h1>
          <p>Hi ${name}, your trip has been confirmed:</p>
          <div style="background:#F3F4F6;padding:16px;border-radius:8px;margin:16px 0">
            <p><strong>Driver:</strong> ${tripDetails.driverName}</p>
            <p><strong>Pickup:</strong> ${tripDetails.pickup}</p>
            <p><strong>Dropoff:</strong> ${tripDetails.dropoff}</p>
            <p><strong>Time:</strong> ${tripDetails.time}</p>
            <p><strong>Price:</strong> ${tripDetails.price}</p>
          </div>
          <p style="color:#6B7280;font-size:0.875rem">You'll receive notifications as your trip approaches.</p>
        </div>
      `,
    });
  }
}

// ---------------------------------------------------------------------------
// Unified Notification Dispatcher
// ---------------------------------------------------------------------------

export class NotificationService {
  private twilio: TwilioService | null;
  private sendgrid: SendGridService | null;

  constructor(env: Bindings) {
    this.twilio = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER
      ? new TwilioService(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_PHONE_NUMBER)
      : null;

    this.sendgrid = env.SENDGRID_API_KEY
      ? new SendGridService(env.SENDGRID_API_KEY)
      : null;
  }

  get smsAvailable(): boolean { return !!this.twilio; }
  get emailAvailable(): boolean { return !!this.sendgrid; }

  async sendSMS(to: string, body: string): Promise<boolean> {
    if (!this.twilio) {
      logger.warn('SMS not configured, skipping', { to: to.slice(-4) });
      return false;
    }
    try {
      await this.twilio.sendSMS(to, body);
      return true;
    } catch (err) {
      logger.error('SMS send failed', err as Error, { to: to.slice(-4) });
      return false;
    }
  }

  async sendEmail(to: string, subject: string, html: string, text?: string): Promise<boolean> {
    if (!this.sendgrid) {
      logger.warn('Email not configured, skipping', { to, subject });
      return false;
    }
    try {
      await this.sendgrid.sendEmail({ to, subject, html, text });
      return true;
    } catch (err) {
      logger.error('Email send failed', err as Error, { to, subject });
      return false;
    }
  }

  getSendGrid(): SendGridService | null { return this.sendgrid; }
}
