-- Migration 009: Rate limiting en 2FA pending state naar Supabase
-- Voer dit uit in Supabase SQL Editor

-- Tabel voor login rate limiting (vervangt in-memory Map)
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  first_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ
);

-- Automatisch opruimen van verlopen entries (ouder dan 1 uur)
CREATE INDEX IF NOT EXISTS idx_login_attempts_first_attempt ON login_attempts(first_attempt);

-- Tabel voor 2FA pending state (vervangt in-memory Map)
CREATE TABLE IF NOT EXISTS pending_2fa (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  supabase_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes')
);

-- Index voor opruimen van verlopen pending 2FA tokens
CREATE INDEX IF NOT EXISTS idx_pending_2fa_expires_at ON pending_2fa(expires_at);

-- RLS inschakelen (server gebruikt service role key, geen extra policies nodig)
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_2fa ENABLE ROW LEVEL SECURITY;
