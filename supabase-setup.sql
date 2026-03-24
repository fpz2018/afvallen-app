-- =====================================================
-- Weight Loss Assessment Web-App
-- Supabase Database Setup
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- =====================================================

-- 1. PATIENTS TABLE
CREATE TABLE IF NOT EXISTS patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(20),
    date_of_birth DATE,
    gender VARCHAR(10),
    patient_type VARCHAR(1) CHECK (patient_type IN ('A', 'B', 'C', 'D')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);

-- 2. ASSESSMENTS TABLE
CREATE TABLE IF NOT EXISTS assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    assessment_type VARCHAR(20) CHECK (assessment_type IN ('quick', 'standard', 'deep')),
    determined_type VARCHAR(50),
    categories JSONB DEFAULT '[]'::jsonb,
    responses JSONB DEFAULT '{}'::jsonb,
    risk_scores JSONB DEFAULT '{}'::jsonb,
    completed BOOLEAN DEFAULT FALSE
);

-- 3. LAB TESTS TABLE
CREATE TABLE IF NOT EXISTS lab_tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    test_package VARCHAR(50),
    recommended_tests JSONB DEFAULT '[]'::jsonb,
    ordered_date DATE,
    result_date DATE,
    results JSONB DEFAULT '{}'::jsonb,
    interpretations JSONB DEFAULT '[]'::jsonb,
    status VARCHAR(20) DEFAULT 'recommended' CHECK (status IN ('recommended', 'ordered', 'completed'))
);

-- 4. SUPPLEMENT PROTOCOLS TABLE
CREATE TABLE IF NOT EXISTS supplement_protocols (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    protocol_type VARCHAR(50),
    supplements JSONB DEFAULT '[]'::jsonb,
    nutrition JSONB DEFAULT '{}'::jsonb,
    lifestyle JSONB DEFAULT '{}'::jsonb,
    medication_advice JSONB DEFAULT '{}'::jsonb,
    start_date DATE,
    duration_weeks INTEGER,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped')),
    notes TEXT
);

-- 5. PROGRESS TRACKING TABLE
CREATE TABLE IF NOT EXISTS progress_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    measurement_date DATE NOT NULL,
    weight_kg DECIMAL(5,2),
    waist_cm DECIMAL(5,1),
    symptoms JSONB DEFAULT '{}'::jsonb,
    energy_level INTEGER CHECK (energy_level BETWEEN 1 AND 10),
    notes TEXT
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(email);
CREATE INDEX IF NOT EXISTS idx_patients_status ON patients(status);
CREATE INDEX IF NOT EXISTS idx_assessments_patient ON assessments(patient_id);
CREATE INDEX IF NOT EXISTS idx_assessments_completed ON assessments(completed);
CREATE INDEX IF NOT EXISTS idx_lab_tests_patient ON lab_tests(patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_tests_status ON lab_tests(status);
CREATE INDEX IF NOT EXISTS idx_supplements_patient ON supplement_protocols(patient_id);
CREATE INDEX IF NOT EXISTS idx_supplements_status ON supplement_protocols(status);
CREATE INDEX IF NOT EXISTS idx_progress_patient_date ON progress_tracking(patient_id, measurement_date);

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplement_protocols ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_tracking ENABLE ROW LEVEL SECURITY;

-- Policies: Authenticated users have full access
CREATE POLICY "Authenticated users full access patients" ON patients
    FOR ALL USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access assessments" ON assessments
    FOR ALL USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access lab_tests" ON lab_tests
    FOR ALL USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access supplement_protocols" ON supplement_protocols
    FOR ALL USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access progress_tracking" ON progress_tracking
    FOR ALL USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

-- Anon policies verwijderd - server gebruikt service role key voor alle DB-operaties
-- Zie src/lib/supabase.ts en gebruik SUPABASE_SERVICE_ROLE_KEY in je .env / Netlify env vars
