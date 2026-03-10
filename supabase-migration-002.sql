-- =====================================================
-- Migration: Add risk_profile, stool tests support
-- Run this in Supabase SQL Editor AFTER the initial setup
-- =====================================================

-- Add risk_profile column to assessments
ALTER TABLE assessments 
ADD COLUMN IF NOT EXISTS risk_profile JSONB DEFAULT '{}'::jsonb;

-- Add new columns to lab_tests for blood/stool separation
ALTER TABLE lab_tests 
ADD COLUMN IF NOT EXISTS blood_tests JSONB DEFAULT '[]'::jsonb;

ALTER TABLE lab_tests 
ADD COLUMN IF NOT EXISTS stool_tests JSONB DEFAULT '[]'::jsonb;

ALTER TABLE lab_tests 
ADD COLUMN IF NOT EXISTS other_tests JSONB DEFAULT '[]'::jsonb;

ALTER TABLE lab_tests 
ADD COLUMN IF NOT EXISTS urgency VARCHAR(20) DEFAULT 'low';

ALTER TABLE lab_tests 
ADD COLUMN IF NOT EXISTS rationale TEXT;

-- Extend test_package to support longer names
ALTER TABLE lab_tests 
ALTER COLUMN test_package TYPE VARCHAR(200);
