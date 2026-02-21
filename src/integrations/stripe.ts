/**
 * Klubz - Stripe Payment Integration
 *
 * Handles payment intents, webhooks, and refunds for trip payments.
 * Uses Stripe REST API directly (no Node SDK — Workers compatible).
 */

import type { Bindings } from '../types';
import { logger } from '../lib/logger';

interface StripePaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  client_secret: string;
  metadata: Record<string, string>;
}

interface StripeRefund {
  id: string;
  amount: number;
  status: string;
  payment_intent: string;
}

export class StripeService {
  private baseUrl = 'https://api.stripe.com/v1';
  private secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = new URLSearchParams(body).toString();
    }

    const response = await fetch(`${this.baseUrl}${path}`, options);
    const data = await response.json() as T & { error?: { message: string } };

    if (!response.ok) {
      const err = data as { error?: { message: string } };
      throw new Error(`Stripe API error: ${err.error?.message || response.statusText}`);
    }

    return data;
  }

  /**
   * Create a payment intent for a trip booking.
   */
  async createPaymentIntent(params: {
    amount: number;       // in cents (e.g. 4500 = R45.00)
    currency: string;     // 'zar'
    tripId: number;
    userId: number;
    bookingId?: number;
    description?: string;
  }): Promise<StripePaymentIntent> {
    logger.info('Creating Stripe payment intent', {
      amount: params.amount,
      currency: params.currency,
      tripId: params.tripId,
    });

    const body: Record<string, string> = {
      amount: params.amount.toString(),
      currency: params.currency.toLowerCase(),
      // camelCase keys to match webhook handler expectations
      'metadata[tripId]': params.tripId.toString(),
      'metadata[userId]': params.userId.toString(),
      'metadata[platform]': 'klubz',
      description: params.description || `Klubz trip #${params.tripId}`,
      'automatic_payment_methods[enabled]': 'true',
    };
    if (params.bookingId !== undefined) {
      body['metadata[bookingId]'] = params.bookingId.toString();
    }
    return this.request<StripePaymentIntent>('POST', '/payment_intents', body);
  }

  /**
   * Retrieve a payment intent by ID.
   */
  async getPaymentIntent(id: string): Promise<StripePaymentIntent> {
    return this.request<StripePaymentIntent>('GET', `/payment_intents/${id}`);
  }

  /**
   * Cancel a payment intent.
   */
  async cancelPaymentIntent(id: string): Promise<StripePaymentIntent> {
    return this.request<StripePaymentIntent>('POST', `/payment_intents/${id}/cancel`);
  }

  /**
   * Create a refund for a payment.
   */
  async createRefund(paymentIntentId: string, amount?: number): Promise<StripeRefund> {
    logger.info('Creating Stripe refund', { paymentIntentId, amount });

    const body: Record<string, string> = {
      payment_intent: paymentIntentId,
    };
    if (amount) {
      body.amount = amount.toString();
    }

    return this.request<StripeRefund>('POST', '/refunds', body);
  }

  /**
   * Verify a Stripe webhook signature.
   */
  async verifyWebhookSignature(
    payload: string,
    signature: string,
    webhookSecret: string,
  ): Promise<boolean> {
    const parts = signature.split(',').reduce((acc, part) => {
      const [key, value] = part.split('=');
      acc[key] = value;
      return acc;
    }, {} as Record<string, string>);

    const timestamp = parts['t'];
    const v1Sig = parts['v1'];
    if (!timestamp || !v1Sig) return false;

    // Check timestamp is within 5 minutes
    const ts = parseInt(timestamp, 10);
    if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

    // Compute expected signature
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return expected === v1Sig;
  }
}

/**
 * Factory function to get a Stripe service from environment bindings.
 */
export function getStripeService(env: Bindings): StripeService | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new StripeService(env.STRIPE_SECRET_KEY);
}
