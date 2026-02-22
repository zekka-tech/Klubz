-- Migration 0012: Add OAuth (social sign-in) support
-- Adds oauth_provider and oauth_id columns to the users table so that accounts
-- created via Google Sign-in (or future providers) can be linked and looked up.
--
-- OAuth users have password_hash = 'OAUTH_NO_PASSWORD' (satisfies NOT NULL
-- constraint) so the regular email/password login path cannot be used.
-- email_verified is set TRUE for OAuth users since the provider verified it.

ALTER TABLE users ADD COLUMN oauth_provider TEXT;
ALTER TABLE users ADD COLUMN oauth_id TEXT;

-- Unique partial index: only one account per provider+id combination.
-- Partial index on non-NULL rows avoids conflicts between rows that have no OAuth linkage.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth
  ON users(oauth_provider, oauth_id)
  WHERE oauth_provider IS NOT NULL;
