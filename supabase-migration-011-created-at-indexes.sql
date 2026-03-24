-- Migration 011: Indexes op created_at kolommen voor dashboard queries
-- Voer dit uit in Supabase SQL Editor

CREATE INDEX IF NOT EXISTS idx_patients_created_at ON patients(created_at);
CREATE INDEX IF NOT EXISTS idx_assessments_created_at ON assessments(created_at);
