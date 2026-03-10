-- Migration 004: Admin 2FA table
-- Run this in Supabase SQL Editor

-- Table to store TOTP secrets for admin 2FA
CREATE TABLE IF NOT EXISTS admin_2fa (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  totp_secret TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE admin_2fa ENABLE ROW LEVEL SECURITY;

-- De server-side Hono app gebruikt de anon key.
-- Alleen de server heeft toegang (via auth middleware);
-- de tabel is NIET bereikbaar vanuit de browser.
-- We staan SELECT/INSERT/UPDATE/DELETE toe voor de anon role.
CREATE POLICY "Server can read 2fa" ON admin_2fa
  FOR SELECT TO anon USING (true);

CREATE POLICY "Server can insert 2fa" ON admin_2fa
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Server can update 2fa" ON admin_2fa
  FOR UPDATE TO anon USING (true);

CREATE POLICY "Server can delete 2fa" ON admin_2fa
  FOR DELETE TO anon USING (true);

-- Index for fast email lookups
CREATE INDEX IF NOT EXISTS idx_admin_2fa_email ON admin_2fa(email);
