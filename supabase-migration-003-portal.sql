-- =====================================================
-- Migration 003: Add portal_code to patients table
-- Run this in Supabase SQL Editor
-- =====================================================

-- Add portal_code column for patient portal access
ALTER TABLE patients 
ADD COLUMN IF NOT EXISTS portal_code VARCHAR(10) UNIQUE;

ALTER TABLE patients 
ADD COLUMN IF NOT EXISTS portal_code_created_at TIMESTAMPTZ;

-- Create index for fast portal code lookup
CREATE INDEX IF NOT EXISTS idx_patients_portal_code ON patients(portal_code) WHERE portal_code IS NOT NULL;

-- Update RLS policy to allow portal code verification (read-only for certain columns)
-- Note: This assumes the existing anon key RLS policies are already in place
