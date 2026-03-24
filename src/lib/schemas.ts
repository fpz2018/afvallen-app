import { z } from 'zod'

// =====================================================
// Helper: valideer body en geef fout of data terug
// =====================================================
export function validate<T>(schema: z.ZodType<T>, body: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(body)
  if (!result.success) {
    const first = result.error.errors[0]
    return { ok: false, error: `${first.path.join('.')}: ${first.message}` }
  }
  return { ok: true, data: result.data }
}

// =====================================================
// Auth schemas
// =====================================================
export const LoginSchema = z.object({
  email: z.string().email('Ongeldig e-mailadres'),
  password: z.string().min(1, 'Wachtwoord is verplicht'),
})

export const ResetPasswordSchema = z.object({
  email: z.string().email('Ongeldig e-mailadres'),
})

export const UpdatePasswordSchema = z.object({
  access_token: z.string().min(1, 'Token is verplicht'),
  new_password: z.string().min(8, 'Wachtwoord moet minimaal 8 tekens bevatten'),
})

export const Verify2FASchema = z.object({
  pending_token: z.string().min(1, 'Token is verplicht'),
  totp_code: z.string().length(6, 'Verificatiecode moet 6 cijfers zijn'),
})

export const Enable2FASchema = z.object({
  secret: z.string().min(1, 'Secret is verplicht'),
  totp_code: z.string().length(6, 'Verificatiecode moet 6 cijfers zijn'),
})

export const Disable2FASchema = z.object({
  totp_code: z.string().length(6, 'Verificatiecode moet 6 cijfers zijn'),
})

// =====================================================
// Patiënt schemas
// =====================================================
export const CreatePatientSchema = z.object({
  first_name: z.string().min(1, 'Voornaam is verplicht').max(100),
  last_name: z.string().min(1, 'Achternaam is verplicht').max(100),
  email: z.string().email('Ongeldig e-mailadres').optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  patient_type: z.enum(['A', 'B', 'C', 'D']).optional().nullable(),
})

export const UpdatePatientSchema = CreatePatientSchema.partial()

// =====================================================
// Assessment schema
// =====================================================
const TriageResponsesSchema = z.object({
  gender: z.enum(['male', 'female', 'other']),
  age: z.number().int().min(10).max(120),
  duration_trying: z.string(),
  weight_loss_success: z.string(),
  fatigue_cold_dry: z.string(),
  menstrual_regularity: z.string(),
  stress_frequency: z.string(),
  sleep_quality: z.string(),
  medication_use: z.array(z.string()),
  statin_side_effects: z.string(),
  hunger_after_meal: z.string(),
  fat_distribution: z.string(),
  sugar_cravings: z.string(),
  menopause_status: z.string(),
  diagnosed_conditions: z.array(z.string()),
})

export const CreateAssessmentSchema = z.object({
  patient_id: z.string().uuid('Ongeldig patiënt-ID'),
  responses: TriageResponsesSchema,
  assessment_type: z.enum(['quick', 'standard', 'deep']).default('quick'),
})

// =====================================================
// Protocol schema
// =====================================================
export const CreateProtocolSchema = z.object({
  patient_id: z.string().uuid('Ongeldig patiënt-ID'),
  assessment_id: z.string().uuid('Ongeldig assessment-ID').optional().nullable(),
  categories: z.array(z.string()).min(1, 'Minimaal één categorie verplicht'),
  notes: z.string().max(2000).optional().default(''),
})

// =====================================================
// Voortgang schema
// =====================================================
export const CreateProgressSchema = z.object({
  patient_id: z.string().uuid('Ongeldig patiënt-ID'),
  measurement_date: z.string().min(1, 'Datum is verplicht'),
  weight_kg: z.number().min(20).max(500).optional().nullable(),
  waist_cm: z.number().min(30).max(300).optional().nullable(),
  energy_level: z.number().int().min(1).max(10).optional().nullable(),
  symptoms: z.record(z.unknown()).optional().default({}),
  notes: z.string().max(2000).optional().nullable(),
})

// =====================================================
// Follow-up schemas
// =====================================================
export const CreateFollowUpSchema = z.object({
  patient_id: z.string().uuid('Ongeldig patiënt-ID'),
  scheduled_date: z.string().min(1, 'Datum is verplicht'),
  follow_up_type: z.enum(['check_in', 'measurement', 'lab_control', 'protocol_eval', 'other']).default('check_in'),
  goal: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

export const UpdateFollowUpSchema = z.object({
  scheduled_date: z.string().optional(),
  follow_up_type: z.enum(['check_in', 'measurement', 'lab_control', 'protocol_eval', 'other']).optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
  goal: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  completed_date: z.string().optional().nullable(),
})
