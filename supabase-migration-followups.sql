-- Follow-ups table for scheduling and tracking follow-up appointments
CREATE TABLE IF NOT EXISTS follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  scheduled_date DATE NOT NULL,
  follow_up_type VARCHAR(50) DEFAULT 'check_in',
  status VARCHAR(20) DEFAULT 'scheduled',
  goal TEXT,
  notes TEXT,
  completed_date DATE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_follow_ups_patient_id ON follow_ups(patient_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled_date ON follow_ups(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status);

-- RLS
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "follow_ups_all_authenticated" ON follow_ups
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "follow_ups_anon_read" ON follow_ups
  FOR SELECT TO anon USING (true);

CREATE POLICY "follow_ups_anon_insert" ON follow_ups
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "follow_ups_anon_update" ON follow_ups
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "follow_ups_anon_delete" ON follow_ups
  FOR DELETE TO anon USING (true);
