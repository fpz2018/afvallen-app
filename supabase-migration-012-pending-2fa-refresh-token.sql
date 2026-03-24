-- Migration 012: Voeg refresh token toe aan pending_2fa tabel
-- Voer dit uit in Supabase SQL Editor

ALTER TABLE pending_2fa
  ADD COLUMN IF NOT EXISTS supabase_refresh_token TEXT NOT NULL DEFAULT '';
