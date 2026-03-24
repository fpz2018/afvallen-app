-- Migration 008: Verwijder publieke anon RLS policies
-- Voer dit uit in Supabase SQL Editor
-- Deze policies gaven iedereen zonder login volledige toegang tot patiëntdata

DROP POLICY IF EXISTS "Anon read access patients" ON patients;
DROP POLICY IF EXISTS "Anon read access assessments" ON assessments;
DROP POLICY IF EXISTS "Anon read access lab_tests" ON lab_tests;
DROP POLICY IF EXISTS "Anon read access supplement_protocols" ON supplement_protocols;
DROP POLICY IF EXISTS "Anon read access progress_tracking" ON progress_tracking;
