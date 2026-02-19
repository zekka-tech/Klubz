-- Migration 0009: Track rider passenger count per trip booking

ALTER TABLE trip_participants
ADD COLUMN passenger_count INTEGER NOT NULL DEFAULT 1 CHECK(passenger_count BETWEEN 1 AND 4);
