-- Migration 010: Voeg warnings kolom toe aan supplement_protocols
-- Voer dit uit in Supabase SQL Editor

ALTER TABLE supplement_protocols
  ADD COLUMN IF NOT EXISTS warnings JSONB DEFAULT '[]'::jsonb;
