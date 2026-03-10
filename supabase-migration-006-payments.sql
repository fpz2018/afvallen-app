-- Migration 006: Payments tabel voor Stripe betalingen
-- Voer deze SQL uit in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('analysis', 'protocol')),
  amount INTEGER NOT NULL,  -- bedrag in centen
  currency TEXT DEFAULT 'eur',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payments_patient_id ON payments(patient_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_session ON payments(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- RLS policies (server-side access via anon key)
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Server can read payments" ON payments FOR SELECT TO anon USING (true);
CREATE POLICY "Server can insert payments" ON payments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Server can update payments" ON payments FOR UPDATE TO anon USING (true);
