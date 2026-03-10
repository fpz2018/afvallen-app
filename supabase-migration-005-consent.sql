-- Migration 005: Consent tracking columns voor AVG/GDPR compliance
-- Voer deze SQL uit in Supabase Dashboard > SQL Editor

-- Consent velden toevoegen aan patients tabel
ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent_given BOOLEAN DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent_timestamp TIMESTAMPTZ;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent_ip TEXT;

-- Index voor consent tracking
CREATE INDEX IF NOT EXISTS idx_patients_consent ON patients(consent_given) WHERE consent_given = true;
