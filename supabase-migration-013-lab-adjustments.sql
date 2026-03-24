-- Migration 013: Lab-gebaseerde protocol aanpassingen
-- Voer dit uit in Supabase SQL Editor

ALTER TABLE supplement_protocols
  ADD COLUMN IF NOT EXISTS lab_adjustments JSONB NOT NULL DEFAULT '[]';
