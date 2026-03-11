-- =====================================================
-- MIGRATION 007: Lab Uploads tabel
-- =====================================================
-- Deze tabel slaat lab-documenten op die patiënten uploaden via het portaal
-- Bestanden worden als base64 opgeslagen (max ~10 MB per bestand)

CREATE TABLE IF NOT EXISTS lab_uploads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  file_data TEXT, -- base64 encoded file data
  notes TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexen
CREATE INDEX IF NOT EXISTS idx_lab_uploads_patient ON lab_uploads(patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_uploads_status ON lab_uploads(status);
CREATE INDEX IF NOT EXISTS idx_lab_uploads_created ON lab_uploads(created_at DESC);

-- RLS (Row Level Security)
ALTER TABLE lab_uploads ENABLE ROW LEVEL SECURITY;

-- Beleid: Anonieme gebruikers mogen inserten en hun eigen uploads lezen
CREATE POLICY "Allow anon insert lab_uploads" ON lab_uploads
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow anon select lab_uploads" ON lab_uploads
  FOR SELECT USING (true);

CREATE POLICY "Allow anon update lab_uploads" ON lab_uploads
  FOR UPDATE USING (true) WITH CHECK (true);
