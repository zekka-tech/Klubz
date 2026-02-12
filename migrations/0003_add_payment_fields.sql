-- Migration 0003: Add payment fields to trip_participants
-- Date: 2026-02-12
-- Purpose: Support Stripe payment integration

-- Add payment-related columns to trip_participants
ALTER TABLE trip_participants ADD COLUMN payment_intent_id TEXT;
ALTER TABLE trip_participants ADD COLUMN payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded', 'canceled'));
ALTER TABLE trip_participants ADD COLUMN payment_completed_at DATETIME;

-- Create index for payment intent lookups
CREATE INDEX IF NOT EXISTS idx_trip_participants_payment_intent ON trip_participants(payment_intent_id);

-- Create index for payment status queries
CREATE INDEX IF NOT EXISTS idx_trip_participants_payment_status ON trip_participants(payment_status);
