import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from 'hono/adapter'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { getSupabase } from './lib/supabase'
import { classifyPatient, TriageResponses } from './lib/classification'
import { getLabRecommendations, interpretLabResults, generateRiskProfile } from './lib/lab-recommendations'
import { generateProtocol } from './lib/protocol-engine'

type EnvVars = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string        // voor Supabase Auth REST API calls (login, wachtwoord reset)
  SUPABASE_SERVICE_ROLE_KEY: string // voor database operaties via getSupabase()
  STRIPE_SECRET_KEY: string
  STRIPE_PUBLISHABLE_KEY: string
}

// Helper: haal env variabelen op (werkt op Netlify, Cloudflare, en lokaal)
function getEnv(c: any): EnvVars {
  const honoEnv = env<EnvVars>(c)
  const processEnv = typeof process !== 'undefined' ? (process as any).env || {} : {}
  return {
    SUPABASE_URL: honoEnv.SUPABASE_URL || processEnv.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: honoEnv.SUPABASE_ANON_KEY || processEnv.SUPABASE_ANON_KEY || '',
    SUPABASE_SERVICE_ROLE_KEY: honoEnv.SUPABASE_SERVICE_ROLE_KEY || processEnv.SUPABASE_SERVICE_ROLE_KEY || '',
    STRIPE_SECRET_KEY: honoEnv.STRIPE_SECRET_KEY || processEnv.STRIPE_SECRET_KEY || '',
    STRIPE_PUBLISHABLE_KEY: honoEnv.STRIPE_PUBLISHABLE_KEY || processEnv.STRIPE_PUBLISHABLE_KEY || '',
  }
}

const app = new Hono()

app.use('/api/*', cors())

// =====================================================
// ADMIN AUTH + 2FA + RATE LIMITING
// =====================================================

// --- Crypto helpers ---
function generateSessionToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateTOTPSecret(): string {
  const array = new Uint8Array(20)
  crypto.getRandomValues(array)
  return base32Encode(array)
}

// Base32 encoding voor TOTP secrets
function base32Encode(data: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const byte of data) bits += byte.toString(2).padStart(8, '0')
  let result = ''
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0')
    result += alphabet[parseInt(chunk, 2)]
  }
  return result
}

function base32Decode(str: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of str.toUpperCase()) {
    const idx = alphabet.indexOf(c)
    if (idx === -1) continue
    bits += idx.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return new Uint8Array(bytes)
}

// HMAC-SHA1 voor TOTP (via Web Crypto API)
async function hmacSHA1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, message)
  return new Uint8Array(sig)
}

// TOTP generatie (RFC 6238)
async function generateTOTP(secret: string, time?: number): Promise<string> {
  const key = base32Decode(secret)
  const epoch = Math.floor((time || Date.now()) / 1000)
  const counter = Math.floor(epoch / 30)
  
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint32(4, counter, false)
  
  const hmac = await hmacSHA1(key, new Uint8Array(buffer))
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = ((hmac[offset] & 0x7f) << 24 | (hmac[offset+1] & 0xff) << 16 | (hmac[offset+2] & 0xff) << 8 | (hmac[offset+3] & 0xff)) % 1000000
  
  return code.toString().padStart(6, '0')
}

// TOTP verificatie (met ±1 tijdstap tolerantie voor clock drift)
async function verifyTOTP(secret: string, token: string): Promise<boolean> {
  const now = Date.now()
  for (const offset of [-30000, 0, 30000]) {
    const expected = await generateTOTP(secret, now + offset)
    if (expected === token) return true
  }
  return false
}

// --- Rate limiting via Supabase (vervangt in-memory Map) ---
const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000   // 15 minuten window
const BLOCK_MS = 30 * 60 * 1000    // 30 minuten blokkade

async function checkRateLimit(ip: string, c: any): Promise<{ allowed: boolean, remaining: number, retryAfter?: number }> {
  const db = getSupabase(getEnv(c))
  const now = new Date()

  const { data: entry } = await db.from('login_attempts').select('*').eq('ip', ip).single()

  if (!entry) {
    await db.from('login_attempts').insert({ ip, count: 1, first_attempt: now.toISOString() })
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 }
  }

  // Geblokkeerd?
  if (entry.blocked_until && new Date(entry.blocked_until) > now) {
    const retryAfter = Math.ceil((new Date(entry.blocked_until).getTime() - now.getTime()) / 1000)
    return { allowed: false, remaining: 0, retryAfter }
  }

  // Window verlopen? Reset
  if (new Date(entry.first_attempt).getTime() < now.getTime() - WINDOW_MS) {
    await db.from('login_attempts').update({ count: 1, first_attempt: now.toISOString(), blocked_until: null }).eq('ip', ip)
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 }
  }

  const newCount = entry.count + 1
  if (newCount > MAX_ATTEMPTS) {
    const blockedUntil = new Date(now.getTime() + BLOCK_MS).toISOString()
    await db.from('login_attempts').update({ count: newCount, blocked_until: blockedUntil }).eq('ip', ip)
    return { allowed: false, remaining: 0, retryAfter: Math.ceil(BLOCK_MS / 1000) }
  }

  await db.from('login_attempts').update({ count: newCount }).eq('ip', ip)
  return { allowed: true, remaining: MAX_ATTEMPTS - newCount }
}

async function resetRateLimit(ip: string, c: any): Promise<void> {
  const db = getSupabase(getEnv(c))
  await db.from('login_attempts').delete().eq('ip', ip)
}

// --- Session management via Supabase JWT ---
// Sessies worden niet meer in memory opgeslagen maar gevalideerd via Supabase auth.getUser()
// zodat alle serverless instanties dezelfde sessievalidatie gebruiken.

// Pending 2FA state wordt opgeslagen in Supabase (tabel: pending_2fa)

async function getSessionUser(c: any): Promise<{ valid: boolean, email: string }> {
  const token = getCookie(c, 'admin_session')
  if (!token) return { valid: false, email: '' }

  const db = getSupabase(getEnv(c))
  const { data, error } = await db.auth.getUser(token)

  if (!error && data.user) {
    return { valid: true, email: data.user.email || '' }
  }

  // Access token verlopen — probeer te vernieuwen via refresh token
  const refreshToken = getCookie(c, 'admin_refresh')
  if (!refreshToken) return { valid: false, email: '' }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getEnv(c)
  const refreshResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken })
  })

  if (!refreshResponse.ok) return { valid: false, email: '' }

  const refreshData = await refreshResponse.json() as any
  if (!refreshData.access_token) return { valid: false, email: '' }

  // Nieuwe tokens instellen in cookies
  setCookie(c, 'admin_session', refreshData.access_token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 86400
  })
  setCookie(c, 'admin_refresh', refreshData.refresh_token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400
  })

  return { valid: true, email: refreshData.user?.email || '' }
}

function getClientIP(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 
         c.req.header('x-real-ip') || 
         'unknown'
}

// =====================================================
// AUTH API ENDPOINTS
// =====================================================

// Login stap 1: email + wachtwoord
app.post('/api/admin/login', async (c) => {
  const ip = getClientIP(c)
  const rateCheck = await checkRateLimit(ip, c)

  if (!rateCheck.allowed) {
    return c.json({
      error: `Te veel inlogpogingen. Probeer opnieuw over ${Math.ceil((rateCheck.retryAfter || 1800) / 60)} minuten.`,
      blocked: true,
      retryAfter: rateCheck.retryAfter
    }, 429)
  }

  const { email, password } = await c.req.json()
  if (!email || !password) {
    return c.json({ error: 'Email en wachtwoord zijn verplicht' }, 400)
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getEnv(c)

  // Supabase Auth login
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password })
  })

  const data = await response.json() as any

  if (!response.ok || !data.access_token) {
    return c.json({ error: 'Ongeldige inloggegevens', remaining: rateCheck.remaining }, 401)
  }

  // Check of 2FA is ingeschakeld via admin_2fa tabel
  const db = getSupabase(getEnv(c))
  const { data: faData } = await db.from('admin_2fa').select('totp_secret, enabled').eq('email', data.user?.email || email).single()

  if (faData?.enabled && faData?.totp_secret) {
    // 2FA is ingeschakeld — sla pending state op in Supabase
    const pendingToken = generateSessionToken()
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    await db.from('pending_2fa').insert({
      token: pendingToken,
      email: data.user.email,
      supabase_token: data.access_token,
      supabase_refresh_token: data.refresh_token,
      expires_at: expiresAt
    })

    return c.json({
      requires_2fa: true,
      pending_token: pendingToken,
      email: data.user.email
    })
  }

  // Geen 2FA — direct inloggen met Supabase tokens als cookies
  await resetRateLimit(ip, c)
  setCookie(c, 'admin_session', data.access_token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 86400
  })
  setCookie(c, 'admin_refresh', data.refresh_token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400
  })

  return c.json({ success: true, email: data.user?.email, has_2fa: false })
})

// Wachtwoord vergeten — stuur reset-email via Supabase Auth
app.post('/api/admin/reset-password', async (c) => {
  const ip = getClientIP(c)
  const rateCheck = await checkRateLimit(ip, c)
  if (!rateCheck.allowed) {
    return c.json({ error: `Te veel pogingen. Wacht ${Math.ceil((rateCheck.retryAfter || 1800) / 60)} minuten.`, blocked: true }, 429)
  }

  const { email } = await c.req.json()
  if (!email) {
    return c.json({ error: 'Vul je e-mailadres in' }, 400)
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getEnv(c)

  try {
    // Determine the redirect URL based on request origin
    const origin = c.req.header('origin') || c.req.header('referer')?.replace(/\/[^/]*$/, '') || ''
    const redirectTo = origin ? `${origin}/admin/reset-wachtwoord` : 'https://afvallen.netlify.app/admin/reset-wachtwoord'

    const response = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'apikey': SUPABASE_ANON_KEY 
      },
      body: JSON.stringify({ 
        email,
        gotrue_meta_security: { captcha_token: '' }
      })
    })

    // Always return success to prevent email enumeration
    return c.json({ 
      success: true, 
      message: 'Als dit e-mailadres bekend is, ontvangt u binnen enkele minuten een e-mail met een link om uw wachtwoord te resetten.' 
    })
  } catch (err) {
    console.error('Password reset error:', err)
    return c.json({ 
      success: true, 
      message: 'Als dit e-mailadres bekend is, ontvangt u binnen enkele minuten een e-mail met een link om uw wachtwoord te resetten.' 
    })
  }
})

// Wachtwoord updaten met recovery token
app.post('/api/admin/update-password', async (c) => {
  const { access_token, new_password } = await c.req.json()
  if (!access_token || !new_password) {
    return c.json({ error: 'Token en nieuw wachtwoord zijn verplicht' }, 400)
  }
  if (new_password.length < 8) {
    return c.json({ error: 'Wachtwoord moet minimaal 8 tekens bevatten' }, 400)
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getEnv(c)

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json', 
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${access_token}`
      },
      body: JSON.stringify({ password: new_password })
    })

    const data = await response.json() as any

    if (!response.ok) {
      return c.json({ error: data.msg || data.message || 'Wachtwoord resetten mislukt. Probeer opnieuw of vraag een nieuwe link aan.' }, 400)
    }

    return c.json({ success: true, message: 'Wachtwoord succesvol gewijzigd! U kunt nu inloggen.' })
  } catch (err) {
    console.error('Update password error:', err)
    return c.json({ error: 'Er ging iets mis. Probeer opnieuw.' }, 500)
  }
})

// Login stap 2: 2FA verificatie
app.post('/api/admin/verify-2fa', async (c) => {
  const ip = getClientIP(c)
  const rateCheck = await checkRateLimit(ip, c)
  if (!rateCheck.allowed) {
    return c.json({ error: `Te veel pogingen. Wacht ${Math.ceil((rateCheck.retryAfter || 1800) / 60)} minuten.`, blocked: true }, 429)
  }

  const { pending_token, totp_code } = await c.req.json()
  if (!pending_token || !totp_code) {
    return c.json({ error: 'Token en verificatiecode zijn verplicht' }, 400)
  }

  const db = getSupabase(getEnv(c))

  // Haal pending state op uit Supabase (inclusief expiry check)
  const { data: pending } = await db
    .from('pending_2fa')
    .select('*')
    .eq('token', pending_token)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!pending) {
    await db.from('pending_2fa').delete().eq('token', pending_token)
    return c.json({ error: 'Sessie verlopen. Log opnieuw in.' }, 401)
  }

  // Haal TOTP secret op via admin_2fa tabel
  const { data: faData } = await db.from('admin_2fa').select('totp_secret').eq('email', pending.email).single()
  const secret = faData?.totp_secret

  if (!secret) {
    await db.from('pending_2fa').delete().eq('token', pending_token)
    return c.json({ error: '2FA configuratie niet gevonden' }, 500)
  }

  const valid = await verifyTOTP(secret, totp_code)
  if (!valid) {
    return c.json({ error: 'Ongeldige verificatiecode', remaining: rateCheck.remaining }, 401)
  }

  // 2FA gelukt — Supabase tokens als cookies instellen
  await db.from('pending_2fa').delete().eq('token', pending_token)
  await resetRateLimit(ip, c)
  setCookie(c, 'admin_session', pending.supabase_token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 86400
  })
  setCookie(c, 'admin_refresh', pending.supabase_refresh_token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400
  })

  return c.json({ success: true, email: pending.email })
})

// 2FA Setup: genereer secret + QR URL
app.post('/api/admin/2fa/setup', async (c) => {
  const { valid, email } = await getSessionUser(c)
  if (!valid) return c.json({ error: 'Niet ingelogd' }, 401)

  const secret = generateTOTPSecret()
  const otpauthUrl = `otpauth://totp/GripOpGewicht:${encodeURIComponent(email)}?secret=${secret}&issuer=GripOpGewicht&digits=6&period=30`

  return c.json({ secret, otpauth_url: otpauthUrl, email })
})

// 2FA Activeren: verificeer code en sla secret op
app.post('/api/admin/2fa/enable', async (c) => {
  const { valid: sessionValid, email } = await getSessionUser(c)
  if (!sessionValid) return c.json({ error: 'Niet ingelogd' }, 401)

  const { secret, totp_code } = await c.req.json()
  if (!secret || !totp_code) return c.json({ error: 'Secret en code zijn verplicht' }, 400)

  const valid = await verifyTOTP(secret, totp_code)
  if (!valid) return c.json({ error: 'Ongeldige code. Probeer opnieuw.' }, 400)

  // Sla secret op in admin_2fa tabel
  const db = getSupabase(getEnv(c))
  const { error } = await db.from('admin_2fa').upsert({
    email,
    totp_secret: secret, 
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'email' })

  if (error) {
    console.error('2FA enable error:', error)
    return c.json({ error: 'Fout bij opslaan. Voer eerst de admin_2fa migratie uit in Supabase.' }, 500)
  }

  return c.json({ success: true, message: '2FA is geactiveerd!' })
})

// 2FA Uitschakelen
app.post('/api/admin/2fa/disable', async (c) => {
  const { valid, email } = await getSessionUser(c)
  if (!valid) return c.json({ error: 'Niet ingelogd' }, 401)

  const { totp_code } = await c.req.json()

  // Verifieer huidige 2FA code voordat we uitschakelen
  const db = getSupabase(getEnv(c))
  const { data: fa } = await db.from('admin_2fa').select('totp_secret').eq('email', email).single()

  if (fa?.totp_secret) {
    const validTotp = await verifyTOTP(fa.totp_secret, totp_code)
    if (!validTotp) return c.json({ error: 'Ongeldige verificatiecode' }, 401)
  }

  await db.from('admin_2fa').delete().eq('email', email)
  return c.json({ success: true, message: '2FA is uitgeschakeld' })
})

// 2FA Status check
app.get('/api/admin/2fa/status', async (c) => {
  const { valid, email } = await getSessionUser(c)
  if (!valid) return c.json({ error: 'Niet ingelogd' }, 401)

  const db = getSupabase(getEnv(c))
  const { data, error } = await db.from('admin_2fa').select('enabled').eq('email', email).single()
  
  // Als de tabel niet bestaat, geef dat aan
  if (error && (error.code === 'PGRST204' || error.message?.includes('admin_2fa') || error.code === '42P01')) {
    return c.json({ enabled: false, table_missing: true })
  }
  
  return c.json({ enabled: !!data?.enabled, table_missing: false })
})

// Logout
app.post('/api/admin/logout', (c) => {
  deleteCookie(c, 'admin_session', { path: '/' })
  deleteCookie(c, 'admin_refresh', { path: '/' })
  return c.json({ success: true })
})

// Sessie check
app.get('/api/admin/session', async (c) => {
  const { valid, email } = await getSessionUser(c)
  if (!valid) {
    deleteCookie(c, 'admin_session', { path: '/' })
    return c.json({ authenticated: false }, 401)
  }
  return c.json({ authenticated: true, email })
})

// =====================================================
// AUTH MIDDLEWARE — beschermt /admin/* pagina's EN /api/* data routes
// =====================================================

// Bescherm admin pagina's (redirect naar login)
app.use('/admin/*', async (c, next) => {
  if (c.req.path === '/admin/login' || c.req.path === '/admin/reset-wachtwoord') return next()

  const { valid } = await getSessionUser(c)
  if (!valid) {
    deleteCookie(c, 'admin_session', { path: '/' })
    return c.redirect('/admin/login')
  }
  await next()
})

app.use('/admin', async (c, next) => {
  const { valid } = await getSessionUser(c)
  if (!valid) {
    deleteCookie(c, 'admin_session', { path: '/' })
    return c.redirect('/admin/login')
  }
  await next()
})

// Bescherm ALLE data API routes (return 401 JSON)
// Uitzondering: admin auth endpoints en portal endpoints
app.use('/api/*', async (c, next) => {
  const path = c.req.path
  
  // Deze endpoints zijn publiek (portal + auth + payments)
  if (path.startsWith('/api/admin/login') ||
      path.startsWith('/api/admin/verify-2fa') ||
      path.startsWith('/api/admin/logout') ||
      path.startsWith('/api/admin/reset-password') ||
      path.startsWith('/api/admin/update-password') ||
      path.startsWith('/api/portal/') ||
      path.startsWith('/api/payments/')) {
    return next()
  }

  // Alle andere API routes vereisen admin sessie
  const { valid } = await getSessionUser(c)
  if (!valid) {
    return c.json({ error: 'Niet geautoriseerd. Log in via /admin/login' }, 401)
  }
  
  await next()
})

// =====================================================
// API: PATIENTS
// =====================================================
app.get('/api/patients', async (c) => {
  const db = getSupabase(getEnv(c))
  const status = c.req.query('status') || 'active'
  const { data, error } = await db
    .from('patients')
    .select('*, assessments(id, determined_type, categories, completed, created_at)')
    .eq('status', status)
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.get('/api/patients/:id', async (c) => {
  const db = getSupabase(getEnv(c))
  const { data, error } = await db
    .from('patients')
    .select(`
      *,
      assessments(*),
      lab_tests(*),
      supplement_protocols(*),
      progress_tracking(*)
    `)
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/api/patients', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const { data, error } = await db
    .from('patients')
    .insert([body])
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.patch('/api/patients/:id', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const { data, error } = await db
    .from('patients')
    .update(body)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.delete('/api/patients/:id', async (c) => {
  const db = getSupabase(getEnv(c))
  const { error } = await db
    .from('patients')
    .update({ status: 'archived' })
    .eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// Hard delete: permanently remove patient and all related data
app.delete('/api/patients/:id/permanent', async (c) => {
  const db = getSupabase(getEnv(c))
  const id = c.req.param('id')
  // Delete in order: children first (FK constraints)
  await db.from('follow_ups').delete().eq('patient_id', id)
  await db.from('progress_tracking').delete().eq('patient_id', id)
  await db.from('supplement_protocols').delete().eq('patient_id', id)
  await db.from('lab_tests').delete().eq('patient_id', id)
  await db.from('assessments').delete().eq('patient_id', id)
  const { error } = await db.from('patients').delete().eq('id', id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// =====================================================
// API: ASSESSMENTS
// =====================================================
app.post('/api/assessments', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()

  // Run classification
  const classification = classifyPatient(body.responses as TriageResponses)

  // Generate risk profile
  const riskProfile = generateRiskProfile(
    classification.categories,
    classification.riskScores,
    body.responses
  )

  const assessmentData = {
    patient_id: body.patient_id,
    assessment_type: body.assessment_type || 'quick',
    determined_type: classification.primaryType,
    categories: classification.categories,
    risk_scores: classification.riskScores,
    responses: body.responses,
    risk_profile: riskProfile,
    completed: true
  }

  const { data, error } = await db
    .from('assessments')
    .insert([assessmentData])
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  // Update patient type
  await db
    .from('patients')
    .update({ patient_type: classification.primaryType.charAt(0).toUpperCase() })
    .eq('id', body.patient_id)

  // Generate lab recommendations (blood + stool + other)
  const categoryIds = classification.categories.map(cat => cat.id)
  const labPackage = getLabRecommendations(categoryIds, body.responses)

  // Store lab test recommendation (including stool tests)
  await db
    .from('lab_tests')
    .insert([{
      patient_id: body.patient_id,
      assessment_id: data.id,
      test_package: labPackage.name,
      recommended_tests: labPackage.tests,
      blood_tests: labPackage.bloodTests,
      stool_tests: labPackage.stoolTests,
      other_tests: labPackage.otherTests,
      urgency: labPackage.urgency,
      rationale: labPackage.rationale,
      status: 'recommended'
    }])

  return c.json({
    assessment: data,
    classification,
    riskProfile,
    labRecommendations: labPackage
  }, 201)
})

app.get('/api/assessments/:id', async (c) => {
  const db = getSupabase(getEnv(c))
  const { data, error } = await db
    .from('assessments')
    .select('*')
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// Update review status (admin marks assessment as reviewed)
app.patch('/api/assessments/:id/review', async (c) => {
  const db = getSupabase(getEnv(c))
  const { review_status, reviewer_notes } = await c.req.json()
  
  if (!review_status || !['pending_review', 'reviewed', 'needs_followup'].includes(review_status)) {
    return c.json({ error: 'Ongeldige review status' }, 400)
  }
  
  const updateData: any = { 
    review_status,
    reviewed_at: review_status === 'reviewed' ? new Date().toISOString() : null
  }
  if (reviewer_notes !== undefined) updateData.reviewer_notes = reviewer_notes
  
  const { data, error } = await db
    .from('assessments')
    .update(updateData)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// Get all assessments for a patient (history)
app.get('/api/assessments/patient/:patientId', async (c) => {
  const db = getSupabase(getEnv(c))
  const { data, error } = await db
    .from('assessments')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// =====================================================
// API: LAB TESTS
// =====================================================
app.get('/api/lab-tests/:patientId', async (c) => {
  const db = getSupabase(getEnv(c))
  const { data, error } = await db
    .from('lab_tests')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.patch('/api/lab-tests/:id/results', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()

  // Interpret results
  const interpretations = interpretLabResults(body.results)

  const { data, error } = await db
    .from('lab_tests')
    .update({
      results: body.results,
      interpretations,
      result_date: new Date().toISOString().split('T')[0],
      status: 'completed'
    })
    .eq('id', c.req.param('id'))
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ labTest: data, interpretations })
})

// =====================================================
// API: PROTOCOLS
// =====================================================
app.post('/api/protocols', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()

  const protocol = generateProtocol(body.categories)

  const protocolData = {
    patient_id: body.patient_id,
    assessment_id: body.assessment_id,
    protocol_type: body.categories.join('+'),
    supplements: protocol.supplements,
    nutrition: protocol.nutrition,
    lifestyle: protocol.lifestyle,
    medication_advice: protocol.medicationAdvice,
    warnings: protocol.warnings,
    start_date: new Date().toISOString().split('T')[0],
    duration_weeks: 12,
    status: 'active',
    notes: body.notes || ''
  }

  const { data, error } = await db
    .from('supplement_protocols')
    .insert([protocolData])
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ protocol: data, details: protocol }, 201)
})

app.get('/api/protocols/:patientId', async (c) => {
  const db = getSupabase(getEnv(c))
  const { data, error } = await db
    .from('supplement_protocols')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// =====================================================
// API: PROGRESS TRACKING (with symptom scores)
// =====================================================
app.post('/api/progress', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  // Ensure symptoms is a proper JSONB object
  if (body.symptoms && typeof body.symptoms === 'object') {
    body.symptoms = body.symptoms
  }
  const { data, error } = await db
    .from('progress_tracking')
    .insert([body])
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.get('/api/progress/:patientId', async (c) => {
  const db = getSupabase(getEnv(c))
  const { data, error } = await db
    .from('progress_tracking')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('measurement_date', { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// =====================================================
// API: FOLLOW-UPS
// =====================================================
app.get('/api/follow-ups/:patientId', async (c) => {
  const db = getSupabase(getEnv(c))
  const { data, error } = await db
    .from('follow_ups')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('scheduled_date', { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/api/follow-ups', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const { data, error } = await db
    .from('follow_ups')
    .insert([body])
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.patch('/api/follow-ups/:id', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const { data, error } = await db
    .from('follow_ups')
    .update(body)
    .eq('id', c.req.param('id'))
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.delete('/api/follow-ups/:id', async (c) => {
  const db = getSupabase(getEnv(c))
  const { error } = await db
    .from('follow_ups')
    .delete()
    .eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// =====================================================
// API: DASHBOARD STATS
// =====================================================
app.get('/api/stats', async (c) => {
  const db = getSupabase(getEnv(c))

  const [patients, assessments, labTests, protocols] = await Promise.all([
    db.from('patients').select('id, status, created_at', { count: 'exact' }).eq('status', 'active'),
    db.from('assessments').select('id, completed, created_at', { count: 'exact' }).eq('completed', true),
    db.from('lab_tests').select('id, status', { count: 'exact' }).eq('status', 'recommended'),
    db.from('supplement_protocols').select('id, status', { count: 'exact' }).eq('status', 'active'),
  ])

  return c.json({
    activePatients: patients.count || 0,
    completedAssessments: assessments.count || 0,
    pendingLabTests: labTests.count || 0,
    activeProtocols: protocols.count || 0,
  })
})

// =====================================================
// API: CLASSIFICATION PREVIEW (no save)
// =====================================================
app.post('/api/classify-preview', async (c) => {
  const body = await c.req.json()
  const classification = classifyPatient(body as TriageResponses)
  const categoryIds = classification.categories.map(cat => cat.id)
  const labPackage = getLabRecommendations(categoryIds)
  const protocol = generateProtocol(categoryIds)
  return c.json({ classification, labRecommendations: labPackage, protocol })
})

// =====================================================
// FRONTEND HTML PAGES
// =====================================================

const htmlHead = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weight Loss Assessment - Marc's Praktijk</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            primary: { 50:'#f5f3ff',100:'#ede9fe',200:'#ddd6fe',300:'#c4b5fd',400:'#a78bfa',500:'#8b5cf6',600:'#7c3aed',700:'#6d28d9',800:'#5b21b6',900:'#4c1d95' }
          }
        }
      }
    }
  </script>
  <style>
    .fade-in { animation: fadeIn 0.3s ease-in; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
    .card-hover { transition: all 0.2s; }
    .card-hover:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
    .progress-bar { transition: width 0.5s ease; }
    [x-cloak] { display: none !important; }
  </style>
</head>`

const navBar = `
<nav class="bg-gradient-to-r from-primary-700 to-primary-900 text-white shadow-lg">
  <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
    <a href="/admin" class="flex items-center gap-3 hover:opacity-90">
      <i class="fas fa-weight text-2xl"></i>
      <div>
        <h1 class="text-lg font-bold leading-tight">Weight Loss Assessment</h1>
        <p class="text-xs opacity-75">Admin - Marc's Praktijk</p>
      </div>
    </a>
    <div class="flex items-center gap-4">
      <a href="/admin" class="px-3 py-2 rounded hover:bg-white/10 text-sm"><i class="fas fa-home mr-1"></i> Dashboard</a>
      <a href="/admin/patients" class="px-3 py-2 rounded hover:bg-white/10 text-sm"><i class="fas fa-users mr-1"></i> Patiënten</a>
      <a href="/admin/new-patient" class="bg-white text-primary-700 px-4 py-2 rounded-lg font-semibold text-sm hover:bg-primary-50"><i class="fas fa-plus mr-1"></i> Nieuwe Patiënt</a>
      <a href="/admin/kennisbank" class="px-3 py-2 rounded hover:bg-white/10 text-sm" title="Kennisbank"><i class="fas fa-book-medical mr-1"></i> <span class="hidden lg:inline">Kennisbank</span></a>
      <a href="/admin/beveiliging" class="px-3 py-2 rounded hover:bg-white/10 text-sm" title="Beveiliging"><i class="fas fa-shield-alt"></i></a>
      <button onclick="adminLogout()" class="px-3 py-2 rounded hover:bg-red-500/30 text-sm text-white/70 hover:text-white transition" title="Uitloggen"><i class="fas fa-sign-out-alt"></i></button>
    </div>
  </div>
</nav>
<script>
async function adminLogout() {
  if (!confirm('Wilt u uitloggen?')) return;
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login';
}
</script>`

// ADMIN LOGIN PAGE
// WACHTWOORD RESETTEN PAGINA
app.get('/admin/reset-wachtwoord', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wachtwoord Resetten - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: { extend: { colors: {
        primary: { 50:'#f5f3ff',100:'#ede9fe',200:'#ddd6fe',300:'#c4b5fd',400:'#a78bfa',500:'#8b5cf6',600:'#7c3aed',700:'#6d28d9',800:'#5b21b6',900:'#4c1d95' }
      }}}
    }
  </script>
</head>
<body class="bg-gradient-to-br from-primary-900 via-primary-800 to-indigo-900 min-h-screen flex items-center justify-center px-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mx-auto mb-4 backdrop-blur border border-white/10">
        <i class="fas fa-key text-white text-2xl"></i>
      </div>
      <h1 class="text-2xl font-bold text-white">Wachtwoord Resetten</h1>
      <p class="text-white/60 text-sm mt-1">Kies een nieuw wachtwoord voor uw admin-account</p>
    </div>
    
    <div class="bg-white rounded-2xl shadow-2xl p-8">
      <div id="error-msg" class="hidden bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
        <p class="text-red-700 text-sm font-medium"><i class="fas fa-exclamation-circle mr-1"></i><span id="error-text"></span></p>
      </div>

      <div id="success-msg" class="hidden bg-green-50 border border-green-200 rounded-xl p-4 mb-6 text-center">
        <i class="fas fa-check-circle text-green-500 text-3xl mb-2"></i>
        <p class="text-green-700 font-bold text-lg">Wachtwoord gewijzigd!</p>
        <p class="text-green-600 text-sm mt-1">U kunt nu inloggen met uw nieuwe wachtwoord.</p>
        <a href="/admin/login" class="inline-block mt-4 bg-primary-600 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-primary-700 transition">
          <i class="fas fa-sign-in-alt mr-1"></i>Naar inloggen
        </a>
      </div>

      <div id="reset-fields">
        <div class="mb-5">
          <label class="block text-sm font-semibold text-gray-700 mb-2"><i class="fas fa-lock mr-1 text-gray-400"></i>Nieuw wachtwoord</label>
          <input type="password" id="new-password" required minlength="8"
            class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition text-gray-800"
            placeholder="Minimaal 8 tekens">
        </div>

        <div class="mb-6">
          <label class="block text-sm font-semibold text-gray-700 mb-2"><i class="fas fa-lock mr-1 text-gray-400"></i>Bevestig wachtwoord</label>
          <input type="password" id="confirm-password" required minlength="8"
            class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition text-gray-800"
            placeholder="Herhaal wachtwoord">
        </div>

        <button type="button" id="save-btn" onclick="handleUpdatePassword()"
          class="w-full bg-primary-600 text-white py-3.5 rounded-xl font-bold text-base hover:bg-primary-700 transition shadow-lg shadow-primary-200 flex items-center justify-center gap-2">
          <i class="fas fa-save"></i>
          <span>Wachtwoord opslaan</span>
        </button>
      </div>

      <div class="mt-6 pt-5 border-t text-center">
        <a href="/admin/login" class="text-sm text-gray-400 hover:text-primary-600 transition">
          <i class="fas fa-arrow-left mr-1"></i>Terug naar inloggen
        </a>
      </div>
    </div>
  </div>

  <script>
    // Parse het access_token uit de URL hash (Supabase redirect)
    // Supabase stuurt: #access_token=...&type=recovery&...
    let accessToken = null;

    function parseHashParams() {
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      return params;
    }

    const params = parseHashParams();
    accessToken = params.get('access_token');
    const tokenType = params.get('type');

    if (!accessToken) {
      // Geen token in URL — mogelijk directe navigatie
      document.getElementById('error-text').textContent = 'Geen geldige reset-link gevonden. Vraag een nieuwe reset-link aan via de inlogpagina.';
      document.getElementById('error-msg').classList.remove('hidden');
      document.getElementById('reset-fields').classList.add('hidden');
    }

    function showError(msg) {
      document.getElementById('error-text').textContent = msg;
      document.getElementById('error-msg').classList.remove('hidden');
    }

    async function handleUpdatePassword() {
      document.getElementById('error-msg').classList.add('hidden');
      
      const newPw = document.getElementById('new-password').value;
      const confirmPw = document.getElementById('confirm-password').value;

      if (!newPw || newPw.length < 8) { showError('Wachtwoord moet minimaal 8 tekens bevatten'); return; }
      if (newPw !== confirmPw) { showError('Wachtwoorden komen niet overeen'); return; }

      const btn = document.getElementById('save-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Opslaan...</span>';

      try {
        const res = await fetch('/api/admin/update-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken, new_password: newPw })
        });
        const data = await res.json();

        if (data.success) {
          document.getElementById('reset-fields').classList.add('hidden');
          document.getElementById('error-msg').classList.add('hidden');
          document.getElementById('success-msg').classList.remove('hidden');
        } else {
          showError(data.error || 'Er ging iets mis. Vraag een nieuwe reset-link aan.');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-save"></i><span>Wachtwoord opslaan</span>';
        }
      } catch(e) {
        showError('Verbindingsfout. Probeer opnieuw.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i><span>Wachtwoord opslaan</span>';
      }
    }

    // Enter-toets ondersteuning
    document.getElementById('confirm-password')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleUpdatePassword();
    });
  </script>
</body></html>`)
})

app.get('/admin/login', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login - Weight Loss Assessment</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            primary: { 50:'#f5f3ff',100:'#ede9fe',200:'#ddd6fe',300:'#c4b5fd',400:'#a78bfa',500:'#8b5cf6',600:'#7c3aed',700:'#6d28d9',800:'#5b21b6',900:'#4c1d95' }
          }
        }
      }
    }
  </script>
</head>
<body class="bg-gradient-to-br from-primary-900 via-primary-800 to-indigo-900 min-h-screen flex items-center justify-center px-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mx-auto mb-4 backdrop-blur border border-white/10">
        <i class="fas fa-shield-alt text-white text-2xl"></i>
      </div>
      <h1 class="text-2xl font-bold text-white">Admin Toegang</h1>
      <p class="text-white/60 text-sm mt-1">Weight Loss Assessment - Marc's Praktijk</p>
    </div>
    
    <div class="bg-white rounded-2xl shadow-2xl p-8">
      <div id="error-msg" class="hidden bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
        <p class="text-red-700 text-sm font-medium"><i class="fas fa-exclamation-circle mr-1"></i><span id="error-text"></span></p>
      </div>

      <!-- Stap 1: Email + Wachtwoord -->
      <form id="login-form" onsubmit="handleLogin(event)">
        <div class="mb-5">
          <label class="block text-sm font-semibold text-gray-700 mb-2"><i class="fas fa-envelope mr-1 text-gray-400"></i>Email</label>
          <input type="email" id="email" required autocomplete="email"
            class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition text-gray-800"
            placeholder="marc@fysiopraktijkzeist.nl">
        </div>

        <div class="mb-6">
          <label class="block text-sm font-semibold text-gray-700 mb-2"><i class="fas fa-lock mr-1 text-gray-400"></i>Wachtwoord</label>
          <div class="relative">
            <input type="password" id="password" required autocomplete="current-password"
              class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition text-gray-800 pr-12"
              placeholder="••••••••">
            <button type="button" onclick="togglePassword()" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <i id="eye-icon" class="fas fa-eye"></i>
            </button>
          </div>
        </div>

        <button type="submit" id="login-btn"
          class="w-full bg-primary-600 text-white py-3.5 rounded-xl font-bold text-base hover:bg-primary-700 transition shadow-lg shadow-primary-200 flex items-center justify-center gap-2">
          <i class="fas fa-sign-in-alt"></i>
          <span>Inloggen</span>
        </button>
      </form>

      <!-- Wachtwoord vergeten formulier (verborgen) -->
      <div id="reset-form" class="hidden">
        <div class="text-center mb-6">
          <div class="w-14 h-14 bg-amber-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <i class="fas fa-envelope text-amber-600 text-xl"></i>
          </div>
          <h3 class="text-lg font-bold text-gray-800">Wachtwoord vergeten?</h3>
          <p class="text-sm text-gray-500 mt-1">Vul je e-mailadres in en we sturen een reset-link</p>
        </div>

        <div class="mb-5">
          <label class="block text-sm font-semibold text-gray-700 mb-2"><i class="fas fa-envelope mr-1 text-gray-400"></i>Email</label>
          <input type="email" id="reset-email" required
            class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition text-gray-800"
            placeholder="marc@fysiopraktijkzeist.nl">
        </div>

        <div id="reset-success" class="hidden bg-green-50 border border-green-200 rounded-xl p-4 mb-4">
          <p class="text-green-700 text-sm font-medium"><i class="fas fa-check-circle mr-1"></i><span id="reset-success-text"></span></p>
        </div>

        <button type="button" id="reset-btn" onclick="handleResetPassword()"
          class="w-full bg-amber-500 text-white py-3.5 rounded-xl font-bold text-base hover:bg-amber-600 transition shadow-lg shadow-amber-200 flex items-center justify-center gap-2">
          <i class="fas fa-paper-plane"></i>
          <span>Verstuur reset-link</span>
        </button>

        <button type="button" onclick="backToLoginFromReset()" class="w-full mt-3 py-2.5 text-sm text-gray-500 hover:text-primary-600 transition">
          <i class="fas fa-arrow-left mr-1"></i>Terug naar inloggen
        </button>
      </div>

      <!-- Stap 2: 2FA Verificatie (verborgen tot nodig) -->
      <div id="totp-form" class="hidden">
        <div class="text-center mb-6">
          <div class="w-14 h-14 bg-primary-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <i class="fas fa-shield-alt text-primary-600 text-xl"></i>
          </div>
          <h3 class="text-lg font-bold text-gray-800">Twee-factor authenticatie</h3>
          <p class="text-sm text-gray-500 mt-1">Voer de 6-cijferige code in van je authenticator app</p>
        </div>

        <div class="mb-6">
          <div class="flex justify-center gap-2" id="totp-inputs">
            <input type="text" maxlength="1" class="totp-digit w-12 h-14 text-center text-xl font-bold rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 outline-none transition" data-idx="0">
            <input type="text" maxlength="1" class="totp-digit w-12 h-14 text-center text-xl font-bold rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 outline-none transition" data-idx="1">
            <input type="text" maxlength="1" class="totp-digit w-12 h-14 text-center text-xl font-bold rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 outline-none transition" data-idx="2">
            <span class="flex items-center text-gray-300 text-xl font-light">-</span>
            <input type="text" maxlength="1" class="totp-digit w-12 h-14 text-center text-xl font-bold rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 outline-none transition" data-idx="3">
            <input type="text" maxlength="1" class="totp-digit w-12 h-14 text-center text-xl font-bold rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 outline-none transition" data-idx="4">
            <input type="text" maxlength="1" class="totp-digit w-12 h-14 text-center text-xl font-bold rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 outline-none transition" data-idx="5">
          </div>
        </div>

        <button type="button" id="verify-btn" onclick="handleVerify2FA()"
          class="w-full bg-primary-600 text-white py-3.5 rounded-xl font-bold text-base hover:bg-primary-700 transition shadow-lg shadow-primary-200 flex items-center justify-center gap-2">
          <i class="fas fa-check-double"></i>
          <span>Verifieer</span>
        </button>

        <button type="button" onclick="backToLogin()" class="w-full mt-3 py-2.5 text-sm text-gray-500 hover:text-primary-600 transition">
          <i class="fas fa-arrow-left mr-1"></i>Terug naar inloggen
        </button>
      </div>

      <div class="mt-6 pt-5 border-t text-center space-y-2">
        <button onclick="showResetForm()" class="text-sm text-primary-600 hover:text-primary-800 font-medium transition block mx-auto">
          <i class="fas fa-key mr-1"></i>Wachtwoord vergeten?
        </button>
        <a href="/" class="text-sm text-gray-400 hover:text-primary-600 transition block">
          <i class="fas fa-arrow-left mr-1"></i>Terug naar portaal
        </a>
      </div>
    </div>

    <p class="text-center text-white/30 text-xs mt-6"><i class="fas fa-lock mr-1"></i>Beveiligde verbinding (HTTPS)</p>
  </div>

  <style>
    .totp-digit::-webkit-outer-spin-button,
    .totp-digit::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  </style>

  <script>
    let pendingToken = null;

    function togglePassword() {
      const pw = document.getElementById('password');
      const icon = document.getElementById('eye-icon');
      if (pw.type === 'password') { pw.type = 'text'; icon.className = 'fas fa-eye-slash'; }
      else { pw.type = 'password'; icon.className = 'fas fa-eye'; }
    }

    function showError(msg) {
      const errDiv = document.getElementById('error-msg');
      document.getElementById('error-text').textContent = msg;
      errDiv.classList.remove('hidden');
    }

    function hideError() {
      document.getElementById('error-msg').classList.add('hidden');
    }

    function show2FAForm() {
      document.getElementById('login-form').classList.add('hidden');
      document.getElementById('totp-form').classList.remove('hidden');
      // Focus eerste digit
      setTimeout(() => document.querySelector('.totp-digit').focus(), 100);
    }

    function backToLogin() {
      pendingToken = null;
      document.getElementById('totp-form').classList.add('hidden');
      document.getElementById('login-form').classList.remove('hidden');
      hideError();
      // Reset TOTP velden
      document.querySelectorAll('.totp-digit').forEach(d => d.value = '');
      const btn = document.getElementById('login-btn');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>Inloggen</span>';
    }

    // TOTP digit navigatie
    document.querySelectorAll('.totp-digit').forEach((input, idx, all) => {
      input.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/[^0-9]/g, '');
        if (e.target.value && idx < all.length - 1) all[idx + 1].focus();
        // Auto-submit als alle 6 ingevuld
        const code = Array.from(all).map(d => d.value).join('');
        if (code.length === 6) handleVerify2FA();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && idx > 0) all[idx - 1].focus();
      });
      // Plakken ondersteuning
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData.getData('text') || '').replace(/[^0-9]/g, '').slice(0, 6);
        pasted.split('').forEach((ch, i) => { if (all[i]) all[i].value = ch; });
        if (pasted.length === 6) handleVerify2FA();
        else if (all[pasted.length]) all[pasted.length].focus();
      });
    });

    function showResetForm() {
      document.getElementById('login-form').classList.add('hidden');
      document.getElementById('totp-form').classList.add('hidden');
      document.getElementById('reset-form').classList.remove('hidden');
      document.getElementById('reset-success').classList.add('hidden');
      hideError();
      document.getElementById('reset-email').value = document.getElementById('email').value || '';
      document.getElementById('reset-email').focus();
    }

    function backToLoginFromReset() {
      document.getElementById('reset-form').classList.add('hidden');
      document.getElementById('login-form').classList.remove('hidden');
      document.getElementById('reset-success').classList.add('hidden');
      hideError();
      const btn = document.getElementById('login-btn');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>Inloggen</span>';
    }

    async function handleResetPassword() {
      hideError();
      const email = document.getElementById('reset-email').value.trim();
      if (!email) { showError('Vul je e-mailadres in'); return; }
      
      const btn = document.getElementById('reset-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Versturen...</span>';

      try {
        const res = await fetch('/api/admin/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();

        if (data.success) {
          document.getElementById('reset-success-text').textContent = data.message;
          document.getElementById('reset-success').classList.remove('hidden');
          btn.innerHTML = '<i class="fas fa-check"></i><span>Verstuurd!</span>';
          btn.classList.remove('bg-amber-500','hover:bg-amber-600');
          btn.classList.add('bg-green-500');
        } else {
          showError(data.error || 'Er ging iets mis');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-paper-plane"></i><span>Verstuur reset-link</span>';
        }
      } catch(e) {
        showError('Verbindingsfout. Probeer opnieuw.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i><span>Verstuur reset-link</span>';
      }
    }

    async function handleLogin(e) {
      e.preventDefault();
      hideError();
      const btn = document.getElementById('login-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Bezig met inloggen...</span>';

      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('email').value,
            password: document.getElementById('password').value
          })
        });
        const data = await res.json();

        if (res.ok && data.requires_2fa) {
          // 2FA vereist — toon TOTP invoer
          pendingToken = data.pending_token;
          show2FAForm();
          return;
        }

        if (res.ok && data.success) {
          btn.innerHTML = '<i class="fas fa-check"></i><span>Ingelogd! Even geduld...</span>';
          btn.className = btn.className.replace('bg-primary-600', 'bg-green-600').replace('hover:bg-primary-700', 'hover:bg-green-700').replace('shadow-primary-200', 'shadow-green-200');
          setTimeout(() => { window.location.href = '/admin'; }, 500);
        } else {
          showError(data.error || 'Inloggen mislukt');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>Inloggen</span>';
        }
      } catch(err) {
        showError('Verbindingsfout. Probeer opnieuw.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>Inloggen</span>';
      }
    }

    async function handleVerify2FA() {
      hideError();
      const code = Array.from(document.querySelectorAll('.totp-digit')).map(d => d.value).join('');
      if (code.length !== 6) { showError('Voer alle 6 cijfers in'); return; }

      const btn = document.getElementById('verify-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Verifiëren...</span>';

      try {
        const res = await fetch('/api/admin/verify-2fa', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pending_token: pendingToken, totp_code: code })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          btn.innerHTML = '<i class="fas fa-check"></i><span>Geverifieerd!</span>';
          btn.className = btn.className.replace('bg-primary-600', 'bg-green-600').replace('hover:bg-primary-700', 'hover:bg-green-700').replace('shadow-primary-200', 'shadow-green-200');
          setTimeout(() => { window.location.href = '/admin'; }, 500);
        } else {
          showError(data.error || 'Verificatie mislukt');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-check-double"></i><span>Verifieer</span>';
          // Reset velden
          document.querySelectorAll('.totp-digit').forEach(d => d.value = '');
          document.querySelector('.totp-digit').focus();
        }
      } catch(err) {
        showError('Verbindingsfout. Probeer opnieuw.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check-double"></i><span>Verifieer</span>';
      }
    }
  </script>
</body></html>`)
})

// BEVEILIGING / 2FA INSTELLINGEN
app.get('/admin/beveiliging', (c) => {
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-3xl mx-auto px-4 py-8">
    <div class="mb-8">
      <a href="/admin" class="text-primary-600 hover:underline text-sm mb-2 inline-block"><i class="fas fa-arrow-left mr-1"></i>Terug naar dashboard</a>
      <h2 class="text-2xl font-bold text-gray-800"><i class="fas fa-shield-alt mr-2 text-primary-600"></i>Beveiliging</h2>
      <p class="text-gray-500">Beheer twee-factor authenticatie en beveiligingsinstellingen</p>
    </div>

    <div id="loading" class="text-center py-12">
      <i class="fas fa-spinner fa-spin text-3xl text-primary-500"></i>
      <p class="text-gray-500 mt-3">Laden...</p>
    </div>

    <!-- 2FA Status -->
    <div id="security-content" class="hidden space-y-6">
      
      <!-- Migratie waarschuwing -->
      <div id="migration-warning" class="hidden bg-red-50 border-2 border-red-300 rounded-2xl p-6">
        <h3 class="text-lg font-bold text-red-700 mb-2"><i class="fas fa-database mr-2"></i>Database migratie vereist</h3>
        <p class="text-sm text-red-600 mb-3">De <code class="bg-red-100 px-1.5 py-0.5 rounded font-mono text-xs">admin_2fa</code> tabel bestaat nog niet in je Supabase database. Voer de migratie uit om 2FA te kunnen gebruiken:</p>
        <ol class="text-sm text-red-600 space-y-1.5 list-decimal list-inside mb-3">
          <li>Ga naar <a href="https://supabase.com/dashboard" target="_blank" class="underline font-semibold">Supabase Dashboard</a></li>
          <li>Open je project → <strong>SQL Editor</strong></li>
          <li>Kopieer de SQL hieronder en voer uit</li>
          <li>Herlaad deze pagina</li>
        </ol>
        <details class="mt-2">
          <summary class="cursor-pointer text-sm font-semibold text-red-700 hover:text-red-800">Toon SQL migratie</summary>
          <pre class="mt-2 bg-gray-900 text-green-400 p-4 rounded-xl text-xs overflow-x-auto whitespace-pre">CREATE TABLE IF NOT EXISTS admin_2fa (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  totp_secret TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_2fa ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Server can read 2fa" ON admin_2fa FOR SELECT TO anon USING (true);
CREATE POLICY "Server can insert 2fa" ON admin_2fa FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Server can update 2fa" ON admin_2fa FOR UPDATE TO anon USING (true);
CREATE POLICY "Server can delete 2fa" ON admin_2fa FOR DELETE TO anon USING (true);

CREATE INDEX IF NOT EXISTS idx_admin_2fa_email ON admin_2fa(email);</pre>
        </details>
      </div>

      <!-- 2FA Status Card -->
      <div class="bg-white rounded-2xl shadow-sm border p-6">
        <div class="flex items-start justify-between">
          <div>
            <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-mobile-alt mr-2"></i>Twee-factor authenticatie (2FA)</h3>
            <p class="text-sm text-gray-500 mt-1">Gebruik een authenticator app (Google Authenticator, Authy, 1Password) als extra beveiligingslaag bij het inloggen.</p>
          </div>
          <span id="2fa-badge" class="px-3 py-1 rounded-full text-xs font-bold"></span>
        </div>

        <div id="2fa-enabled-info" class="hidden mt-4 p-4 bg-green-50 border border-green-200 rounded-xl">
          <div class="flex items-center gap-2 text-green-700">
            <i class="fas fa-check-circle text-lg"></i>
            <span class="font-semibold">2FA is actief</span>
          </div>
          <p class="text-green-600 text-sm mt-1">Je account is extra beveiligd. Bij elke login wordt een 6-cijferige code gevraagd.</p>
          <button onclick="disable2FAStart()" class="mt-4 px-5 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition">
            <i class="fas fa-times-circle mr-1"></i>2FA uitschakelen
          </button>
        </div>

        <div id="2fa-disabled-info" class="hidden mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
          <div class="flex items-center gap-2 text-yellow-700">
            <i class="fas fa-exclamation-triangle text-lg"></i>
            <span class="font-semibold">2FA is niet actief</span>
          </div>
          <p class="text-yellow-600 text-sm mt-1">Je account is alleen beveiligd met een wachtwoord. Schakel 2FA in voor extra bescherming van patiëntgegevens.</p>
          <button onclick="setup2FAStart()" class="mt-4 px-5 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 transition">
            <i class="fas fa-shield-alt mr-1"></i>2FA inschakelen
          </button>
        </div>
      </div>

      <!-- 2FA Setup Wizard (verborgen tot nodig) -->
      <div id="setup-wizard" class="hidden bg-white rounded-2xl shadow-sm border p-6">
        <h3 class="text-lg font-bold text-gray-800 mb-4"><i class="fas fa-cog mr-2 text-primary-600"></i>2FA Instellen</h3>
        
        <!-- Stap 1: QR Code -->
        <div id="setup-step1">
          <div class="bg-gray-50 rounded-xl p-6 text-center">
            <p class="text-sm text-gray-600 mb-4">Scan deze QR-code met je authenticator app:</p>
            <div id="qr-container" class="inline-block bg-white p-4 rounded-xl shadow-inner mb-4">
              <img id="qr-image" class="w-48 h-48" alt="QR Code">
            </div>
            <div class="mt-3">
              <p class="text-xs text-gray-400 mb-1">Of voer deze code handmatig in:</p>
              <div class="flex items-center justify-center gap-2">
                <code id="manual-secret" class="bg-gray-100 px-3 py-1.5 rounded-lg text-sm font-mono font-bold text-gray-700 select-all"></code>
                <button onclick="copySecret()" class="text-primary-600 hover:text-primary-700" title="Kopieer">
                  <i class="fas fa-copy"></i>
                </button>
              </div>
            </div>
          </div>

          <div class="mt-6">
            <p class="text-sm font-semibold text-gray-700 mb-2">Voer de 6-cijferige code in ter bevestiging:</p>
            <div class="flex items-center gap-3">
              <input type="text" id="setup-code" maxlength="6" pattern="[0-9]{6}" inputmode="numeric"
                class="w-40 px-4 py-3 rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 outline-none text-center text-xl font-bold tracking-widest"
                placeholder="000000">
              <button onclick="activate2FA()" id="activate-btn"
                class="px-6 py-3 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 transition flex items-center gap-2">
                <i class="fas fa-check"></i>Activeer
              </button>
            </div>
          </div>

          <button onclick="cancelSetup()" class="mt-4 text-sm text-gray-400 hover:text-gray-600">
            <i class="fas fa-times mr-1"></i>Annuleren
          </button>
        </div>
      </div>

      <!-- Disable 2FA Dialog (verborgen tot nodig) -->
      <div id="disable-dialog" class="hidden bg-white rounded-2xl shadow-sm border p-6">
        <h3 class="text-lg font-bold text-red-600 mb-2"><i class="fas fa-exclamation-triangle mr-2"></i>2FA Uitschakelen</h3>
        <p class="text-sm text-gray-600 mb-4">Voer je huidige authenticator code in om 2FA uit te schakelen. Dit maakt je account kwetsbaarder.</p>
        <div class="flex items-center gap-3">
          <input type="text" id="disable-code" maxlength="6" pattern="[0-9]{6}" inputmode="numeric"
            class="w-40 px-4 py-3 rounded-xl border-2 border-gray-200 focus:border-red-500 focus:ring-2 focus:ring-red-200 outline-none text-center text-xl font-bold tracking-widest"
            placeholder="000000">
          <button onclick="disable2FAConfirm()" id="disable-btn"
            class="px-6 py-3 bg-red-600 text-white rounded-xl font-semibold hover:bg-red-700 transition flex items-center gap-2">
            <i class="fas fa-times-circle"></i>Uitschakelen
          </button>
        </div>
        <button onclick="cancelDisable()" class="mt-4 text-sm text-gray-400 hover:text-gray-600">
          <i class="fas fa-arrow-left mr-1"></i>Annuleren
        </button>
      </div>

      <!-- Beveiligingstips -->
      <div class="bg-blue-50 border border-blue-200 rounded-2xl p-6">
        <h3 class="text-sm font-bold text-blue-800 mb-3"><i class="fas fa-info-circle mr-1"></i>Beveiligingstips voor patiëntgegevens</h3>
        <ul class="text-sm text-blue-700 space-y-2">
          <li><i class="fas fa-check text-blue-500 mr-2 w-4"></i>Gebruik een sterk, uniek wachtwoord van minimaal 12 tekens</li>
          <li><i class="fas fa-check text-blue-500 mr-2 w-4"></i>Schakel 2FA in voor extra bescherming (verplicht aanbevolen bij medische data)</li>
          <li><i class="fas fa-check text-blue-500 mr-2 w-4"></i>Log altijd uit na gebruik, vooral op gedeelde apparaten</li>
          <li><i class="fas fa-check text-blue-500 mr-2 w-4"></i>Deel je inloggegevens nooit met anderen</li>
          <li><i class="fas fa-check text-blue-500 mr-2 w-4"></i>Bewaar je authenticator backup-codes op een veilige plek</li>
        </ul>
      </div>
    </div>

    <!-- Success/Error Messages -->
    <div id="msg-success" class="hidden fixed top-6 right-6 bg-green-600 text-white px-6 py-3 rounded-xl shadow-lg z-50 flex items-center gap-2">
      <i class="fas fa-check-circle"></i><span id="msg-success-text"></span>
    </div>
    <div id="msg-error" class="hidden fixed top-6 right-6 bg-red-600 text-white px-6 py-3 rounded-xl shadow-lg z-50 flex items-center gap-2">
      <i class="fas fa-exclamation-circle"></i><span id="msg-error-text"></span>
    </div>
  </main>

  <script>
    let currentSecret = null;

    function showMsg(type, text) {
      const el = document.getElementById('msg-' + type);
      document.getElementById('msg-' + type + '-text').textContent = text;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 4000);
    }

    async function load2FAStatus() {
      try {
        const res = await fetch('/api/admin/2fa/status');
        if (res.status === 401) { window.location.href = '/admin/login'; return; }
        const data = await res.json();
        
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('security-content').classList.remove('hidden');

        // Toon migratie-waarschuwing als tabel ontbreekt
        const migWarning = document.getElementById('migration-warning');
        if (data.table_missing && migWarning) {
          migWarning.classList.remove('hidden');
        }

        if (data.enabled) {
          document.getElementById('2fa-badge').textContent = 'ACTIEF';
          document.getElementById('2fa-badge').className = 'px-3 py-1 rounded-full text-xs font-bold bg-green-100 text-green-700';
          document.getElementById('2fa-enabled-info').classList.remove('hidden');
          document.getElementById('2fa-disabled-info').classList.add('hidden');
        } else {
          document.getElementById('2fa-badge').textContent = 'NIET ACTIEF';
          document.getElementById('2fa-badge').className = 'px-3 py-1 rounded-full text-xs font-bold bg-yellow-100 text-yellow-700';
          document.getElementById('2fa-enabled-info').classList.add('hidden');
          document.getElementById('2fa-disabled-info').classList.remove('hidden');
        }
      } catch(e) {
        document.getElementById('loading').innerHTML = '<p class="text-red-500">Fout bij laden. <a href="/admin/beveiliging" class="underline">Herlaad</a></p>';
      }
    }

    async function setup2FAStart() {
      try {
        const res = await fetch('/api/admin/2fa/setup', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showMsg('error', data.error || 'Fout'); return; }

        currentSecret = data.secret;
        document.getElementById('manual-secret').textContent = data.secret;
        
        // QR code genereren via externe API
        const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(data.otpauth_url);
        document.getElementById('qr-image').src = qrUrl;

        document.getElementById('2fa-disabled-info').classList.add('hidden');
        document.getElementById('setup-wizard').classList.remove('hidden');
      } catch(e) {
        showMsg('error', 'Verbindingsfout');
      }
    }

    function copySecret() {
      navigator.clipboard.writeText(currentSecret);
      showMsg('success', 'Code gekopieerd!');
    }

    function cancelSetup() {
      currentSecret = null;
      document.getElementById('setup-wizard').classList.add('hidden');
      document.getElementById('setup-code').value = '';
      load2FAStatus();
    }

    async function activate2FA() {
      const code = document.getElementById('setup-code').value.trim();
      if (code.length !== 6 || !/^[0-9]{6}$/.test(code)) {
        showMsg('error', 'Voer een geldige 6-cijferige code in'); return;
      }

      const btn = document.getElementById('activate-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Bezig...';

      try {
        const res = await fetch('/api/admin/2fa/enable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: currentSecret, totp_code: code })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          showMsg('success', '2FA is succesvol geactiveerd!');
          currentSecret = null;
          document.getElementById('setup-wizard').classList.add('hidden');
          document.getElementById('setup-code').value = '';
          load2FAStatus();
        } else {
          showMsg('error', data.error || 'Activering mislukt');
        }
      } catch(e) {
        showMsg('error', 'Verbindingsfout');
      }
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-check"></i>Activeer';
    }

    function disable2FAStart() {
      document.getElementById('2fa-enabled-info').classList.add('hidden');
      document.getElementById('disable-dialog').classList.remove('hidden');
    }

    function cancelDisable() {
      document.getElementById('disable-dialog').classList.add('hidden');
      document.getElementById('disable-code').value = '';
      load2FAStatus();
    }

    async function disable2FAConfirm() {
      const code = document.getElementById('disable-code').value.trim();
      if (code.length !== 6 || !/^[0-9]{6}$/.test(code)) {
        showMsg('error', 'Voer een geldige 6-cijferige code in'); return;
      }

      const btn = document.getElementById('disable-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Bezig...';

      try {
        const res = await fetch('/api/admin/2fa/disable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ totp_code: code })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          showMsg('success', '2FA is uitgeschakeld');
          document.getElementById('disable-dialog').classList.add('hidden');
          document.getElementById('disable-code').value = '';
          load2FAStatus();
        } else {
          showMsg('error', data.error || 'Uitschakelen mislukt');
        }
      } catch(e) {
        showMsg('error', 'Verbindingsfout');
      }
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-times-circle"></i>Uitschakelen';
    }

    // Enter key handlers
    document.getElementById('setup-code').addEventListener('keypress', (e) => { if (e.key === 'Enter') activate2FA(); });
    document.getElementById('disable-code').addEventListener('keypress', (e) => { if (e.key === 'Enter') disable2FAConfirm(); });

    load2FAStatus();
  </script>
</body></html>`)
})

// DASHBOARD
app.get('/admin', (c) => {
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-7xl mx-auto px-4 py-8">
    <div class="mb-8">
      <h2 class="text-2xl font-bold text-gray-800">Dashboard</h2>
      <p class="text-gray-500">Overzicht van je praktijk</p>
    </div>

    <!-- Stats Cards -->
    <div id="stats" class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
      <div class="bg-white rounded-xl shadow p-6 card-hover border-l-4 border-blue-500">
        <div class="flex items-center justify-between">
          <div><p class="text-sm text-gray-500">Actieve Patiënten</p><p id="stat-patients" class="text-3xl font-bold text-blue-600">-</p></div>
          <div class="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center"><i class="fas fa-users text-blue-600 text-xl"></i></div>
        </div>
      </div>
      <div class="bg-white rounded-xl shadow p-6 card-hover border-l-4 border-green-500">
        <div class="flex items-center justify-between">
          <div><p class="text-sm text-gray-500">Assessments</p><p id="stat-assessments" class="text-3xl font-bold text-green-600">-</p></div>
          <div class="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center"><i class="fas fa-clipboard-check text-green-600 text-xl"></i></div>
        </div>
      </div>
      <div class="bg-white rounded-xl shadow p-6 card-hover border-l-4 border-yellow-500">
        <div class="flex items-center justify-between">
          <div><p class="text-sm text-gray-500">Lab-testen Wachten</p><p id="stat-labs" class="text-3xl font-bold text-yellow-600">-</p></div>
          <div class="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center"><i class="fas fa-flask text-yellow-600 text-xl"></i></div>
        </div>
      </div>
      <div class="bg-white rounded-xl shadow p-6 card-hover border-l-4 border-purple-500">
        <div class="flex items-center justify-between">
          <div><p class="text-sm text-gray-500">Actieve Protocollen</p><p id="stat-protocols" class="text-3xl font-bold text-purple-600">-</p></div>
          <div class="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center"><i class="fas fa-pills text-purple-600 text-xl"></i></div>
        </div>
      </div>
    </div>

    <!-- Recent Patients -->
    <div class="bg-white rounded-xl shadow">
      <div class="p-6 border-b flex items-center justify-between">
        <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-clock mr-2 text-primary-600"></i>Recente Patiënten</h3>
        <a href="/admin/new-patient" class="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary-700"><i class="fas fa-plus mr-1"></i> Nieuwe Patiënt</a>
      </div>
      <div id="patient-list" class="p-6">
        <p class="text-gray-400 text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Laden...</p>
      </div>
    </div>
  </main>

  <script>
    async function loadDashboard() {
      try {
        const [statsRes, patientsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/patients')
        ]);
        const stats = await statsRes.json();
        const patients = await patientsRes.json();

        document.getElementById('stat-patients').textContent = stats.activePatients;
        document.getElementById('stat-assessments').textContent = stats.completedAssessments;
        document.getElementById('stat-labs').textContent = stats.pendingLabTests;
        document.getElementById('stat-protocols').textContent = stats.activeProtocols;

        const list = document.getElementById('patient-list');
        if (!patients.length) {
          list.innerHTML = '<div class="text-center py-12"><i class="fas fa-user-plus text-4xl text-gray-300 mb-4"></i><p class="text-gray-400 mb-4">Nog geen patiënten</p><a href="/admin/new-patient" class="bg-primary-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-primary-700">Voeg eerste patiënt toe</a></div>';
          return;
        }

        const categoryColors = {metabolic_resistance:'bg-red-100 text-red-700',thyroid:'bg-indigo-100 text-indigo-700',hormonal:'bg-pink-100 text-pink-700',cortisol:'bg-orange-100 text-orange-700',insulin:'bg-red-100 text-red-700',medication:'bg-blue-100 text-blue-700',standard:'bg-green-100 text-green-700'};
        const categoryNames = {metabolic_resistance:'Metabole Weerstand',thyroid:'Schildklier',hormonal:'PCOS/Hormonen',cortisol:'Cortisol',insulin:'Insuline',medication:'Medicatie',standard:'Standaard'};

        list.innerHTML = '<table class="w-full"><thead><tr class="text-left text-sm text-gray-500 border-b"><th class="pb-3">Naam</th><th class="pb-3">Leeftijd</th><th class="pb-3">Categorieën</th><th class="pb-3">Status</th><th class="pb-3">Acties</th></tr></thead><tbody>' +
          patients.slice(0, 10).map(p => {
            const age = p.date_of_birth ? Math.floor((Date.now() - new Date(p.date_of_birth).getTime()) / 31557600000) : '-';
            const lastAssessment = p.assessments?.sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0];
            const cats = lastAssessment?.categories || [];
            const catTags = cats.map(cat => '<span class="inline-block px-2 py-1 rounded-full text-xs font-semibold ' + (categoryColors[cat.id]||'bg-gray-100 text-gray-700') + '">' + (categoryNames[cat.id]||cat.name) + '</span>').join(' ');
            const statusBadge = lastAssessment ? '<span class="px-2 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">Assessment voltooid</span>' : '<span class="px-2 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">Nieuw</span>';
            return '<tr class="border-b hover:bg-gray-50"><td class="py-3 font-semibold">' + p.first_name + ' ' + p.last_name + '</td><td class="py-3">' + age + '</td><td class="py-3"><div class="flex flex-wrap gap-1">' + (catTags||'-') + '</div></td><td class="py-3">' + statusBadge + '</td><td class="py-3"><a href="/admin/patient/' + p.id + '" class="text-primary-600 hover:text-primary-800 font-semibold text-sm mr-3"><i class="fas fa-eye mr-1"></i>Bekijk</a>' + (!lastAssessment ? '<a href="/admin/triage/' + p.id + '" class="text-green-600 hover:text-green-800 font-semibold text-sm mr-3"><i class="fas fa-clipboard-check mr-1"></i>Start Triage</a>' : '') + '<button onclick="deletePatient(\\'' + p.id + '\\',\\'' + p.first_name + ' ' + p.last_name + '\\')" class="text-red-400 hover:text-red-600 text-sm" title="Verwijder patiënt"><i class="fas fa-trash-alt"></i></button></td></tr>';
          }).join('') + '</tbody></table>';
      } catch(e) {
        console.error(e);
        document.getElementById('patient-list').innerHTML = '<p class="text-red-500 text-center py-8">Fout bij laden. Controleer database verbinding.</p>';
      }
    }
    loadDashboard();

    async function deletePatient(id, name) {
      if (!confirm('Weet je zeker dat je "' + name + '" definitief wilt verwijderen?\\n\\nAlle bijbehorende data (assessments, lab-testen, protocollen, progressie) wordt ook verwijderd.\\n\\nDit kan NIET ongedaan worden gemaakt!')) return;
      try {
        const res = await fetch('/api/patients/' + id + '/permanent', { method: 'DELETE' });
        if (res.ok) { loadDashboard(); }
        else { const err = await res.json(); alert('Fout: ' + (err.error || 'Onbekend')); }
      } catch(e) { alert('Fout: ' + e.message); }
    }
  </script>
</body>
</html>`)
})

// NEW PATIENT PAGE
app.get('/admin/new-patient', (c) => {
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-2xl mx-auto px-4 py-8">
    <div class="mb-6">
      <a href="/" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar Dashboard</a>
    </div>
    <div class="bg-white rounded-xl shadow p-8">
      <h2 class="text-2xl font-bold text-gray-800 mb-6"><i class="fas fa-user-plus mr-2 text-primary-600"></i>Nieuwe Patiënt</h2>
      <form id="patient-form" class="space-y-6">
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-sm font-semibold text-gray-700 mb-1">Voornaam *</label><input name="first_name" required class="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Voornaam"></div>
          <div><label class="block text-sm font-semibold text-gray-700 mb-1">Achternaam *</label><input name="last_name" required class="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Achternaam"></div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-sm font-semibold text-gray-700 mb-1">Email</label><input name="email" type="email" class="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="email@voorbeeld.nl"></div>
          <div><label class="block text-sm font-semibold text-gray-700 mb-1">Telefoon</label><input name="phone" class="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="06-12345678"></div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-sm font-semibold text-gray-700 mb-1">Geboortedatum</label><input name="date_of_birth" type="date" class="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"></div>
          <div><label class="block text-sm font-semibold text-gray-700 mb-1">Geslacht</label>
            <select name="gender" class="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
              <option value="">Kies...</option><option value="male">Man</option><option value="female">Vrouw</option><option value="other">Anders</option>
            </select>
          </div>
        </div>
        <div class="flex gap-4">
          <button type="submit" class="bg-primary-600 text-white px-8 py-3 rounded-lg font-bold hover:bg-primary-700 transition"><i class="fas fa-save mr-2"></i>Opslaan & Start Triage</button>
          <a href="/" class="px-6 py-3 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium">Annuleren</a>
        </div>
      </form>
      <div id="form-message" class="mt-4 hidden"></div>
    </div>
  </main>
  <script>
    document.getElementById('patient-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      // Remove empty fields
      Object.keys(data).forEach(k => { if (!data[k]) delete data[k]; });
      try {
        const res = await fetch('/api/patients', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
        const result = await res.json();
        if (res.ok) {
          window.location.href = '/admin/triage/' + result.id;
        } else {
          document.getElementById('form-message').className = 'mt-4 p-4 bg-red-50 text-red-700 rounded-lg';
          document.getElementById('form-message').textContent = result.error || 'Fout bij opslaan';
        }
      } catch(err) {
        document.getElementById('form-message').className = 'mt-4 p-4 bg-red-50 text-red-700 rounded-lg';
        document.getElementById('form-message').textContent = 'Netwerkfout: ' + err.message;
      }
    });
  </script>
</body></html>`)
})

// PATIENTS LIST PAGE
app.get('/admin/patients', (c) => {
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-7xl mx-auto px-4 py-8">
    <div class="flex justify-between items-center mb-8">
      <div><h2 class="text-2xl font-bold text-gray-800">Patiënten</h2><p class="text-gray-500">Alle actieve patiënten</p></div>
      <a href="/admin/new-patient" class="bg-primary-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-primary-700"><i class="fas fa-plus mr-1"></i> Nieuwe Patiënt</a>
    </div>
    <div id="patients-container" class="bg-white rounded-xl shadow p-6">
      <p class="text-gray-400 text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Laden...</p>
    </div>
  </main>
  <script>
    async function loadPatients() {
      const container = document.getElementById('patients-container');
      try {
        const res = await fetch('/api/patients');
        const patients = await res.json();
        if (!patients.length) { container.innerHTML = '<div class="text-center py-12"><p class="text-gray-400">Nog geen patiënten</p></div>'; return; }
        const categoryNames = {metabolic_resistance:'Metabole Weerstand',thyroid:'Schildklier',hormonal:'PCOS/Hormonen',cortisol:'Cortisol',insulin:'Insuline',medication:'Medicatie',standard:'Standaard'};
        const catColors = {metabolic_resistance:'bg-red-100 text-red-700',thyroid:'bg-indigo-100 text-indigo-700',hormonal:'bg-pink-100 text-pink-700',cortisol:'bg-orange-100 text-orange-700',insulin:'bg-red-100 text-red-700',medication:'bg-blue-100 text-blue-700',standard:'bg-green-100 text-green-700'};
        container.innerHTML = '<div class="space-y-3">' + patients.map(p => {
          const age = p.date_of_birth ? Math.floor((Date.now()-new Date(p.date_of_birth).getTime())/31557600000) : '-';
          const lastA = p.assessments?.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
          const cats = (lastA?.categories||[]).map(c => '<span class="px-2 py-1 rounded-full text-xs font-semibold '+(catColors[c.id]||'bg-gray-100 text-gray-700')+'">'+(categoryNames[c.id]||c.name)+'</span>').join(' ');
          return '<a href="/admin/patient/'+p.id+'" class="block border rounded-xl p-4 hover:shadow-md transition card-hover"><div class="flex items-center justify-between"><div><p class="font-bold text-gray-800">'+p.first_name+' '+p.last_name+'</p><p class="text-sm text-gray-500">'+age+' jaar | '+new Date(p.created_at).toLocaleDateString('nl-NL')+'</p></div><div class="flex flex-wrap gap-1">'+cats+'</div></div></a>';
        }).join('') + '</div>';
      } catch(e) { container.innerHTML = '<p class="text-red-500 text-center">Fout bij laden: '+e.message+'</p>'; }
    }
    loadPatients();
  </script>
</body></html>`)
})

// QUICK TRIAGE PAGE
app.get('/admin/triage/:patientId', (c) => {
  const patientId = c.req.param('patientId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-3xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug</a></div>

    <div class="bg-white rounded-xl shadow">
      <div class="bg-gradient-to-r from-blue-500 to-cyan-500 text-white p-6 rounded-t-xl">
        <h2 class="text-2xl font-bold"><i class="fas fa-clipboard-check mr-2"></i>Quick Triage Assessment</h2>
        <p class="opacity-90 mt-1" id="patient-name">Laden...</p>
        <p class="text-sm opacity-75">Geschatte tijd: 5-10 minuten | 15 vragen</p>
      </div>

      <div class="p-6">
        <div class="mb-6">
          <div class="bg-gray-200 rounded-full h-3"><div id="progress-bar" class="bg-blue-600 h-3 rounded-full progress-bar" style="width:0%"></div></div>
          <p id="progress-text" class="text-xs text-gray-500 mt-1">Vraag 1 van 15</p>
        </div>

        <div id="question-container"></div>

        <div class="flex justify-between mt-8">
          <button id="btn-prev" onclick="prevQuestion()" class="px-6 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium disabled:opacity-30" disabled><i class="fas fa-arrow-left mr-1"></i> Vorige</button>
          <button id="btn-next" onclick="nextQuestion()" class="bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-blue-700">Volgende <i class="fas fa-arrow-right ml-1"></i></button>
        </div>
      </div>
    </div>
  </main>

  <script>
    const patientId = '${patientId}';
    let currentQ = 0;
    const answers = {};

    const questions = [
      { id:'gender', text:'Wat is uw geslacht?', type:'choice', options:[{value:'male',label:'Man'},{value:'female',label:'Vrouw'},{value:'other',label:'Anders'}], indicator:'Basis' },
      { id:'age', text:'Wat is uw leeftijd?', type:'number', placeholder:'Bijv. 42', indicator:'Basis' },
      { id:'duration_trying', text:'Hoe lang probeert u al af te vallen?', type:'choice', options:[{value:'less_3_months',label:'Minder dan 3 maanden'},{value:'3_6_months',label:'3-6 maanden'},{value:'6_12_months',label:'6-12 maanden'},{value:'over_1_year',label:'Meer dan 1 jaar'}], indicator:'Metabole weerstand' },
      { id:'weight_loss_success', text:'Valt u af ondanks calorierestrictie en beweging?', type:'choice', options:[{value:'easy',label:'Ja, moeiteloos'},{value:'slow',label:'Langzaam maar wel'},{value:'barely',label:'Nauwelijks / plateau'},{value:'none',label:'Nee, geen resultaat'}], indicator:'Metabole weerstand' },
      { id:'fatigue_cold_dry', text:'Bent u vaak moe, heeft u het vaak koud en heeft u droge huid?', type:'choice', options:[{value:'yes',label:'Ja, regelmatig tot dagelijks'},{value:'sometimes',label:'Soms, maar niet altijd'},{value:'no',label:'Nee, dit herken ik niet'}], indicator:'Schildklier' },
      { id:'menstrual_regularity', text:'Vrouwen: Is uw menstruatiecyclus regelmatig?', type:'choice', options:[{value:'yes',label:'Ja, regelmatig'},{value:'irregular',label:'Onregelmatig'},{value:'no',label:'Nee'},{value:'na',label:'Niet van toepassing'}], indicator:'PCOS/Hormonen' },
      { id:'stress_frequency', text:'Ervaart u regelmatig stress of angst?', type:'choice', options:[{value:'daily',label:'Dagelijks'},{value:'weekly',label:'Wekelijks'},{value:'rarely',label:'Zelden'},{value:'never',label:'Nooit'}], indicator:'Cortisol' },
      { id:'sleep_quality', text:'Hoe is uw slaap?', type:'choice', options:[{value:'excellent',label:'Uitstekend (7-9 uur doorslapen)'},{value:'fair',label:'Redelijk (wordt soms wakker)'},{value:'moderate',label:'Matig (moeite met inslapen)'},{value:'poor',label:'Slecht (< 6 uur of zeer onrustig)'}], indicator:'Cortisol/Leptine' },
      { id:'medication_use', text:'Welke medicijnen gebruikt u?', type:'multi', options:[{value:'none',label:'Geen medicijnen'},{value:'thyroid_med',label:'Schildkliermedicatie'},{value:'statins',label:'Statines (cholesterol)'},{value:'diabetes_med',label:'Diabetesmedicatie'},{value:'antidepressants',label:'Antidepressiva'},{value:'beta_blockers',label:'Bètablokkers'},{value:'other',label:'Anders'}], indicator:'Medicatie' },
      { id:'statin_side_effects', text:'Heeft u last van spierpijn of vermoeidheid bij statinegebruik?', type:'choice', options:[{value:'yes',label:'Ja'},{value:'no',label:'Nee'},{value:'no_statins',label:'Gebruik geen statines'}], indicator:'CoQ10' },
      { id:'hunger_after_meal', text:'Heeft u honger kort na een maaltijd (< 2 uur)?', type:'choice', options:[{value:'always',label:'Altijd'},{value:'often',label:'Vaak'},{value:'sometimes',label:'Soms'},{value:'never',label:'Nooit'}], indicator:'Insuline' },
      { id:'fat_distribution', text:'Waar zit het meeste vet bij u?', type:'choice', options:[{value:'belly',label:'Buik (visceraal)'},{value:'hips_legs',label:'Heupen/benen'},{value:'even',label:'Gelijkmatig verdeeld'},{value:'unsure',label:'Onzeker'}], indicator:'Hormonale distributie' },
      { id:'sugar_cravings', text:'Heeft u sterke cravings voor suiker/zoet?', type:'choice', options:[{value:'daily',label:'Dagelijks'},{value:'regularly',label:'Regelmatig'},{value:'rarely',label:'Zelden'},{value:'never',label:'Nooit'}], indicator:'Insuline/Serotonine' },
      { id:'menopause_status', text:'Bent u in de overgang of postmenopauzaal?', type:'choice', options:[{value:'yes',label:'Ja'},{value:'no',label:'Nee'},{value:'unsure',label:'Weet niet'},{value:'na',label:'Niet van toepassing'}], indicator:'Oestrogeen' },
      { id:'diagnosed_conditions', text:'Heeft u een diagnose van:', type:'multi', options:[{value:'diabetes',label:'Diabetes type 2'},{value:'pcos',label:'PCOS'},{value:'hashimoto',label:'Hashimoto'},{value:'thyroid',label:'Andere schildklieraandoening'},{value:'none',label:'Geen van bovenstaande'}], indicator:'Pathologie' }
    ];

    async function init() {
      try {
        const res = await fetch('/api/patients/' + patientId);
        const p = await res.json();
        document.getElementById('patient-name').textContent = p.first_name + ' ' + p.last_name;
        // Pre-fill gender and age if available
        if (p.gender) answers.gender = p.gender;
        if (p.date_of_birth) answers.age = Math.floor((Date.now()-new Date(p.date_of_birth).getTime())/31557600000);
      } catch(e) {}
      renderQuestion();
    }

    function renderQuestion() {
      const q = questions[currentQ];
      const pct = ((currentQ+1)/questions.length*100).toFixed(0);
      document.getElementById('progress-bar').style.width = pct+'%';
      document.getElementById('progress-text').textContent = 'Vraag '+(currentQ+1)+' van '+questions.length;
      document.getElementById('btn-prev').disabled = currentQ === 0;
      document.getElementById('btn-next').textContent = currentQ === questions.length-1 ? 'Resultaten bekijken ' : 'Volgende ';
      document.getElementById('btn-next').innerHTML = currentQ === questions.length-1 ? '<i class="fas fa-chart-bar mr-1"></i> Resultaten bekijken' : 'Volgende <i class="fas fa-arrow-right ml-1"></i>';

      let html = '<div class="fade-in"><div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-4"><p class="text-xs text-blue-600 font-semibold mb-1"><i class="fas fa-tag mr-1"></i>'+q.indicator+'</p><p class="font-bold text-lg text-gray-800">'+(currentQ+1)+'. '+q.text+'</p></div>';

      if (q.type === 'choice') {
        html += '<div class="space-y-2">';
        q.options.forEach(opt => {
          const selected = answers[q.id] === opt.value;
          html += '<label class="block p-4 rounded-lg border-2 cursor-pointer transition '+(selected?'border-blue-500 bg-blue-50':'border-gray-200 hover:border-blue-300')+'"><input type="radio" name="'+q.id+'" value="'+opt.value+'" '+(selected?'checked':'')+' onchange="setAnswer(\\''+q.id+'\\',\\''+opt.value+'\\',\\'choice\\')" class="mr-3"> <span class="font-medium">'+opt.label+'</span></label>';
        });
        html += '</div>';
      } else if (q.type === 'number') {
        html += '<input type="number" id="num-input" value="'+(answers[q.id]||'')+'" oninput="setAnswer(\\''+q.id+'\\',this.value,\\'number\\')" class="w-full border-2 border-gray-200 rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="'+q.placeholder+'">';
      } else if (q.type === 'multi') {
        html += '<div class="space-y-2">';
        const selected = answers[q.id] || [];
        q.options.forEach(opt => {
          const isChecked = selected.includes(opt.value);
          html += '<label class="block p-4 rounded-lg border-2 cursor-pointer transition '+(isChecked?'border-blue-500 bg-blue-50':'border-gray-200 hover:border-blue-300')+'"><input type="checkbox" value="'+opt.value+'" '+(isChecked?'checked':'')+' onchange="toggleMulti(\\''+q.id+'\\',\\''+opt.value+'\\',this.checked)" class="mr-3"> <span class="font-medium">'+opt.label+'</span></label>';
        });
        html += '</div>';
      }
      html += '</div>';
      document.getElementById('question-container').innerHTML = html;
    }

    function setAnswer(id, value, type) {
      if (type === 'number') answers[id] = parseInt(value) || 0;
      else answers[id] = value;
      // Re-render for visual update
      renderQuestion();
    }

    function toggleMulti(id, value, checked) {
      if (!answers[id]) answers[id] = [];
      if (value === 'none' && checked) { answers[id] = ['none']; }
      else if (checked) { answers[id] = answers[id].filter(v=>v!=='none'); answers[id].push(value); }
      else { answers[id] = answers[id].filter(v => v !== value); }
      renderQuestion();
    }

    function nextQuestion() {
      const q = questions[currentQ];
      if (!answers[q.id] || (Array.isArray(answers[q.id]) && !answers[q.id].length)) {
        alert('Beantwoord deze vraag a.u.b.');
        return;
      }
      if (currentQ < questions.length - 1) { currentQ++; renderQuestion(); }
      else { submitAssessment(); }
    }

    function prevQuestion() {
      if (currentQ > 0) { currentQ--; renderQuestion(); }
    }

    async function submitAssessment() {
      document.getElementById('btn-next').disabled = true;
      document.getElementById('btn-next').innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Analyseren...';
      try {
        const res = await fetch('/api/assessments', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ patient_id: patientId, assessment_type: 'quick', responses: answers })
        });
        const result = await res.json();
        if (res.ok) {
          window.location.href = '/admin/results/' + patientId + '/' + result.assessment.id;
        } else {
          alert('Fout: ' + (result.error || 'Onbekend'));
          document.getElementById('btn-next').disabled = false;
          document.getElementById('btn-next').innerHTML = '<i class="fas fa-chart-bar mr-1"></i> Resultaten bekijken';
        }
      } catch(e) {
        alert('Netwerkfout: ' + e.message);
        document.getElementById('btn-next').disabled = false;
      }
    }

    init();
  </script>
</body></html>`)
})

// RESULTS PAGE - Risicoprofiel + Bloed + Ontlasting
app.get('/admin/results/:patientId/:assessmentId', (c) => {
  const patientId = c.req.param('patientId')
  const assessmentId = c.req.param('assessmentId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-5xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/admin/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
    <div id="results-container"><p class="text-center py-12 text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>Resultaten laden...</p></div>
  </main>
  <script>
    const patientId = '${patientId}';
    const assessmentId = '${assessmentId}';
    const riskColors = {high:'border-red-500 bg-red-50',medium:'border-orange-500 bg-orange-50',low:'border-green-500 bg-green-50'};
    const riskLabels = {high:'HOOG RISICO',medium:'GEMIDDELD RISICO',low:'LAAG RISICO'};
    const riskTextColors = {high:'text-red-700',medium:'text-orange-700',low:'text-green-700'};
    const riskBgColors = {high:'bg-red-500',medium:'bg-orange-500',low:'bg-green-500'};
    const urgencyColors = {urgent:'bg-red-600',moderate:'bg-orange-500',routine:'bg-green-600'};
    const categoryNames = {metabolic_resistance:'Metabole Weerstand',thyroid:'Schildklier',hormonal:'PCOS/Hormonen',cortisol:'Cortisol',insulin:'Insuline',medication:'Medicatie',standard:'Standaard'};

    async function loadResults() {
      try {
        const [patientRes, assessmentRes, labRes] = await Promise.all([
          fetch('/api/patients/'+patientId),
          fetch('/api/assessments/'+assessmentId),
          fetch('/api/lab-tests/'+patientId)
        ]);
        const patient = await patientRes.json();
        const assessment = await assessmentRes.json();
        const labs = await labRes.json();
        const categories = assessment.categories || [];
        const riskProfile = assessment.risk_profile || {};
        const riskScores = assessment.risk_scores || {};
        const latestLab = labs.find(l => l.assessment_id === assessmentId) || labs[0];

        let html = '';

        // ============ SECTION 1: RISICOPROFIEL ============
        const overallRisk = riskProfile.overallRisk || 'low';
        const urgency = riskProfile.urgency || 'routine';
        html += '<div class="bg-white rounded-xl shadow mb-6">';
        html += '<div class="bg-gradient-to-r '+(overallRisk==='high'?'from-red-600 to-red-800':overallRisk==='medium'?'from-orange-500 to-orange-700':'from-green-500 to-green-700')+' text-white p-6 rounded-t-xl">';
        html += '<div class="flex items-center justify-between"><div><h2 class="text-2xl font-bold"><i class="fas fa-shield-alt mr-2"></i>Risicoprofiel: '+patient.first_name+' '+patient.last_name+'</h2>';
        html += '<p class="opacity-90 mt-1">Assessment voltooid op '+new Date(assessment.created_at).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric'})+'</p></div>';
        html += '<div class="text-right"><div class="text-4xl font-black">'+(overallRisk==='high'?'HOOG':overallRisk==='medium'?'MIDDEN':'LAAG')+'</div><div class="text-sm opacity-90">Algeheel Risiconiveau</div></div></div></div>';

        // Urgency bar
        html += '<div class="p-6 border-b"><div class="flex items-center gap-4 mb-4"><div class="px-4 py-2 rounded-lg text-white font-bold text-sm '+(urgencyColors[urgency]||'bg-gray-500')+'"><i class="fas '+(urgency==='urgent'?'fa-exclamation-triangle':urgency==='moderate'?'fa-exclamation-circle':'fa-check-circle')+' mr-1"></i>'+(riskProfile.urgencyLabel||'Routine')+'</div></div>';

        // Summary
        html += '<div class="bg-gray-50 rounded-lg p-4 mb-4"><p class="text-gray-800 font-medium">'+( riskProfile.summary || 'Geen samenvatting beschikbaar')+'</p></div>';

        // Risk scores visual
        html += '<h4 class="font-bold text-gray-700 mb-3"><i class="fas fa-chart-bar mr-2"></i>Risicoscores per categorie</h4>';
        html += '<div class="space-y-2 mb-4">';
        Object.entries(riskScores).sort((a,b)=>b[1]-a[1]).forEach(([key, score]) => {
          const pct = Math.min((score/10)*100, 100);
          const barColor = score >= 6 ? 'bg-red-500' : score >= 4 ? 'bg-orange-500' : score >= 3 ? 'bg-yellow-400' : 'bg-green-400';
          const threshold = score >= 4 || (key === 'thyroid' && score >= 3) || (key === 'hormonal' && score >= 3) || (key === 'medication' && score >= 3);
          html += '<div class="flex items-center gap-3"><span class="text-xs font-semibold text-gray-600 w-36 text-right">'+(categoryNames[key]||key)+'</span><div class="flex-1 bg-gray-200 rounded-full h-5 relative"><div class="h-5 rounded-full '+barColor+' transition-all flex items-center justify-end pr-2" style="width:'+Math.max(pct,8)+'%"><span class="text-xs text-white font-bold">'+score+'</span></div></div>'+(threshold?'<i class="fas fa-exclamation-circle text-red-500 text-sm" title="Boven drempelwaarde"></i>':'<i class="fas fa-check-circle text-green-500 text-sm" title="Onder drempelwaarde"></i>')+'</div>';
        });
        html += '</div>';

        // Categories
        html += '<h4 class="font-bold text-gray-700 mb-3"><i class="fas fa-tags mr-2"></i>Geïdentificeerde Categorieën ('+categories.length+')</h4><div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">';
        categories.forEach(cat => {
          html += '<div class="border-l-4 p-4 rounded-lg '+riskColors[cat.risk]+'"><div class="flex items-center justify-between mb-1"><p class="font-bold '+riskTextColors[cat.risk]+'"><i class="fas '+cat.icon+' mr-2"></i>'+cat.name+'</p><span class="text-xs font-bold px-2 py-0.5 rounded '+(cat.risk==='high'?'bg-red-200 text-red-800':cat.risk==='medium'?'bg-orange-200 text-orange-800':'bg-green-200 text-green-800')+'">'+riskLabels[cat.risk]+'</span></div><ul class="text-sm mt-1 ml-4 list-disc '+riskTextColors[cat.risk]+'">'+cat.triggers.map(t=>'<li>'+t+'</li>').join('')+'</ul></div>';
        });
        html += '</div>';

        // Attention points
        if (riskProfile.attentionPoints?.length) {
          html += '<div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4"><h4 class="font-bold text-yellow-800 mb-2"><i class="fas fa-exclamation-triangle mr-2"></i>Aandachtspunten voor Therapeut</h4><ul class="space-y-2">';
          riskProfile.attentionPoints.forEach(ap => {
            html += '<li class="flex items-start gap-2 text-sm text-yellow-800"><i class="fas fa-chevron-right mt-1 text-yellow-600"></i><span>'+ap+'</span></li>';
          });
          html += '</ul></div>';
        }

        // Special flags
        let flagsHtml = '';
        if (riskProfile.metabolicSyndromeRisk) flagsHtml += '<span class="px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-300"><i class="fas fa-exclamation-triangle mr-1"></i>Metabool Syndroom Risico</span>';
        if (riskProfile.autoImmuneRisk) flagsHtml += '<span class="px-3 py-1 rounded-full text-xs font-bold bg-purple-100 text-purple-700 border border-purple-300"><i class="fas fa-shield-virus mr-1"></i>Auto-immuun Component</span>';
        if (riskProfile.hormonalComplexity === 'high') flagsHtml += '<span class="px-3 py-1 rounded-full text-xs font-bold bg-pink-100 text-pink-700 border border-pink-300"><i class="fas fa-venus-mars mr-1"></i>Complex Hormonaal Profiel</span>';
        if (flagsHtml) html += '<div class="flex flex-wrap gap-2 mb-4">'+flagsHtml+'</div>';

        // Recommendations
        if (riskProfile.recommendations?.length) {
          html += '<div class="bg-blue-50 border border-blue-200 rounded-lg p-4"><h4 class="font-bold text-blue-800 mb-2"><i class="fas fa-lightbulb mr-2"></i>Aanbevelingen</h4><ol class="space-y-1">';
          riskProfile.recommendations.forEach((rec, i) => {
            html += '<li class="flex items-start gap-2 text-sm text-blue-800"><span class="font-bold text-blue-600 min-w-[20px]">'+(i+1)+'.</span><span>'+rec+'</span></li>';
          });
          html += '</ol></div>';
        }
        html += '</div></div>';

        // ============ SECTION 2: AANVULLEND ONDERZOEK ============
        if (latestLab) {
          const allTests = latestLab.recommended_tests || [];
          const bloodTests = latestLab.blood_tests || allTests.filter(t=>t.type==='blood');
          const stoolTests = latestLab.stool_tests || allTests.filter(t=>t.type==='stool');
          const otherTests = latestLab.other_tests || allTests.filter(t=>!['blood','stool'].includes(t.type));
          const labUrgency = latestLab.urgency || 'low';
          const labRationale = latestLab.rationale || '';

          html += '<div class="bg-white rounded-xl shadow mb-6">';
          html += '<div class="bg-gradient-to-r from-blue-600 to-cyan-600 text-white p-6 rounded-t-xl"><h2 class="text-2xl font-bold"><i class="fas fa-flask mr-2"></i>Aanvullend Onderzoek</h2><p class="opacity-90 mt-1">Automatisch gegenereerd op basis van risicoprofiel</p></div>';

          // Rationale
          html += '<div class="p-6 border-b"><div class="bg-blue-50 rounded-lg p-4 mb-4"><p class="text-sm text-blue-800"><i class="fas fa-info-circle mr-2"></i>'+labRationale+'</p></div>';

          // Urgency badge
          html += '<div class="flex items-center gap-3 mb-4"><span class="px-3 py-1 rounded-lg text-sm font-bold text-white '+(labUrgency==='high'?'bg-red-500':labUrgency==='medium'?'bg-orange-500':'bg-green-500')+'">'+(labUrgency==='high'?'Urgent':labUrgency==='medium'?'Prioriteit':'Routine')+'</span><span class="text-sm text-gray-600">Totaal: '+(bloodTests.length+stoolTests.length+otherTests.length)+' testen ('+(allTests.filter(t=>t.required).length)+' verplicht, '+(allTests.filter(t=>!t.required).length)+' optioneel)</span></div></div>';

          // BLOED
          if (bloodTests.length) {
            const reqBlood = bloodTests.filter(t=>t.required);
            const optBlood = bloodTests.filter(t=>!t.required);
            html += '<div class="p-6 border-b"><h3 class="font-bold text-lg mb-4 flex items-center"><i class="fas fa-tint mr-2 text-red-500"></i>Bloedonderzoek <span class="ml-2 px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">'+bloodTests.length+' testen</span></h3>';

            // Required blood tests
            if (reqBlood.length) {
              html += '<h4 class="font-semibold text-gray-700 mb-2"><i class="fas fa-check-circle text-green-600 mr-1"></i>Verplicht ('+reqBlood.length+')</h4>';
              html += '<div class="grid grid-cols-1 gap-2 mb-4">';
              reqBlood.forEach(t => {
                html += '<div class="border border-gray-200 rounded-lg p-3 hover:shadow-sm transition"><div class="flex items-start justify-between"><div class="flex-1"><div class="flex items-center gap-2"><span class="font-semibold text-gray-800">'+t.name+'</span><span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">'+t.category+'</span></div>';
                if (t.rationale) html += '<p class="text-sm text-gray-600 mt-1"><i class="fas fa-lightbulb text-yellow-500 mr-1"></i>'+t.rationale+'</p>';
                if (t.timing) html += '<p class="text-xs text-blue-600 mt-1"><i class="far fa-clock mr-1"></i>'+t.timing+'</p>';
                if (t.note) html += '<p class="text-xs text-orange-600 mt-1"><i class="fas fa-info-circle mr-1"></i>'+t.note+'</p>';
                html += '</div></div></div>';
              });
              html += '</div>';
            }

            // Optional blood tests
            if (optBlood.length) {
              html += '<details class="mb-2"><summary class="cursor-pointer font-semibold text-gray-600 hover:text-gray-800"><i class="far fa-circle mr-1"></i>Optioneel ('+optBlood.length+') - klik om te bekijken</summary>';
              html += '<div class="grid grid-cols-1 gap-2 mt-2">';
              optBlood.forEach(t => {
                html += '<div class="border border-dashed border-gray-200 rounded-lg p-3 bg-gray-50/50"><div class="flex-1"><div class="flex items-center gap-2"><span class="font-medium text-gray-700">'+t.name+'</span><span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">'+t.category+'</span></div>';
                if (t.rationale) html += '<p class="text-sm text-gray-500 mt-1"><i class="fas fa-lightbulb text-yellow-400 mr-1"></i>'+t.rationale+'</p>';
                if (t.note) html += '<p class="text-xs text-orange-500 mt-1"><i class="fas fa-info-circle mr-1"></i>'+t.note+'</p>';
                html += '</div></div>';
              });
              html += '</div></details>';
            }
            html += '</div>';
          }

          // ONTLASTING
          if (stoolTests.length) {
            const reqStool = stoolTests.filter(t=>t.required);
            const optStool = stoolTests.filter(t=>!t.required);
            html += '<div class="p-6 border-b"><h3 class="font-bold text-lg mb-4 flex items-center"><i class="fas fa-vial mr-2 text-amber-600"></i>Ontlastingsonderzoek <span class="ml-2 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700">'+stoolTests.length+' testen</span></h3>';

            html += '<div class="bg-amber-50 border-l-4 border-amber-500 p-3 rounded mb-4 text-sm text-amber-800"><i class="fas fa-info-circle mr-1"></i><strong>Afname-instructie:</strong> Gebruik de eerste ontlasting van de dag. Verzamel in de meegeleverde buis. Bewaar gekoeld tot verzending. Verstuur op maandag t/m woensdag.</div>';

            if (reqStool.length) {
              html += '<h4 class="font-semibold text-gray-700 mb-2"><i class="fas fa-check-circle text-green-600 mr-1"></i>Verplicht ('+reqStool.length+')</h4>';
              html += '<div class="grid grid-cols-1 gap-2 mb-4">';
              reqStool.forEach(t => {
                html += '<div class="border border-amber-200 rounded-lg p-3 bg-amber-50/30 hover:shadow-sm transition"><div class="flex-1"><div class="flex items-center gap-2"><span class="font-semibold text-gray-800">'+t.name+'</span><span class="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">'+t.category+'</span></div>';
                if (t.rationale) html += '<p class="text-sm text-gray-600 mt-1"><i class="fas fa-lightbulb text-yellow-500 mr-1"></i>'+t.rationale+'</p>';
                if (t.specimen) html += '<p class="text-xs text-amber-700 mt-1"><i class="fas fa-vial mr-1"></i>Materiaal: '+t.specimen+'</p>';
                html += '</div></div>';
              });
              html += '</div>';
            }

            if (optStool.length) {
              html += '<details class="mb-2"><summary class="cursor-pointer font-semibold text-gray-600 hover:text-gray-800"><i class="far fa-circle mr-1"></i>Optioneel ('+optStool.length+') - klik om te bekijken</summary>';
              html += '<div class="grid grid-cols-1 gap-2 mt-2">';
              optStool.forEach(t => {
                html += '<div class="border border-dashed border-amber-200 rounded-lg p-3 bg-gray-50/50"><div class="flex-1"><div class="flex items-center gap-2"><span class="font-medium text-gray-700">'+t.name+'</span><span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">'+t.category+'</span></div>';
                if (t.rationale) html += '<p class="text-sm text-gray-500 mt-1"><i class="fas fa-lightbulb text-yellow-400 mr-1"></i>'+t.rationale+'</p>';
                if (t.note) html += '<p class="text-xs text-orange-500 mt-1"><i class="fas fa-info-circle mr-1"></i>'+t.note+'</p>';
                html += '</div></div>';
              });
              html += '</div></details>';
            }
            html += '</div>';
          }

          // OTHER TESTS (urine, speeksel)
          if (otherTests.length) {
            html += '<div class="p-6 border-b"><h3 class="font-bold text-lg mb-4 flex items-center"><i class="fas fa-microscope mr-2 text-purple-600"></i>Overig Onderzoek <span class="ml-2 px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-700">'+otherTests.length+' testen</span></h3>';
            html += '<div class="grid grid-cols-1 gap-2">';
            otherTests.forEach(t => {
              const typeLabel = {urine:'Urine',saliva:'Speeksel',other:'Overig'}[t.type]||t.type;
              html += '<div class="border border-purple-200 rounded-lg p-3 bg-purple-50/30"><div class="flex-1"><div class="flex items-center gap-2"><span class="font-semibold text-gray-800">'+t.name+'</span><span class="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700">'+typeLabel+'</span>'+(t.required?'<span class="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">Verplicht</span>':'<span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">Optioneel</span>')+'</div>';
              if (t.rationale) html += '<p class="text-sm text-gray-600 mt-1"><i class="fas fa-lightbulb text-yellow-500 mr-1"></i>'+t.rationale+'</p>';
              if (t.timing) html += '<p class="text-xs text-purple-600 mt-1"><i class="far fa-clock mr-1"></i>'+t.timing+'</p>';
              if (t.specimen) html += '<p class="text-xs text-purple-700 mt-1"><i class="fas fa-vial mr-1"></i>'+t.specimen+'</p>';
              html += '</div></div>';
            });
            html += '</div></div>';
          }

          // Lab entry link
          html += '<div class="p-6"><a href="/admin/lab-entry/'+patientId+'/'+latestLab.id+'" class="inline-block bg-green-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-green-700"><i class="fas fa-edit mr-2"></i>Resultaten Invoeren</a></div>';
          html += '</div>';
        }

        // ============ ACTION BUTTONS ============
        html += '<div class="bg-white rounded-xl shadow p-6 flex flex-wrap gap-3"><a href="/admin/patient/'+patientId+'" class="bg-primary-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-primary-700"><i class="fas fa-user mr-2"></i>Patiëntprofiel</a><a href="/admin/assessment/'+patientId+'/'+assessmentId+'" class="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-blue-700"><i class="fas fa-clipboard-list mr-2"></i>Assessment Details</a><button onclick="generateProtocol()" class="bg-green-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-green-700"><i class="fas fa-file-medical mr-2"></i>Genereer Protocol</button><button onclick="window.print()" class="border border-gray-300 px-6 py-3 rounded-lg font-medium hover:bg-gray-50"><i class="fas fa-print mr-2"></i>Print</button></div>';

        document.getElementById('results-container').innerHTML = html;
      } catch(e) {
        document.getElementById('results-container').innerHTML = '<p class="text-red-500 text-center py-12">Fout: '+e.message+'</p>';
      }
    }

    async function generateProtocol() {
      try {
        const aRes = await fetch('/api/assessments/'+assessmentId);
        const assessment = await aRes.json();
        const categoryIds = (assessment.categories||[]).map(c=>c.id);
        const res = await fetch('/api/protocols', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({patient_id:patientId,assessment_id:assessmentId,categories:categoryIds})
        });
        if (res.ok) { window.location.href = '/admin/patient/'+patientId; }
        else { const err = await res.json(); alert('Fout: '+(err.error||'Onbekend')); }
      } catch(e) { alert('Fout: '+e.message); }
    }

    loadResults();
  </script>
</body></html>`)
})

// PATIENT PROFILE PAGE - Extended with symptom scores, charts, lab trends, follow-ups
app.get('/admin/patient/:id', (c) => {
  const patientId = c.req.param('id')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-6xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug</a></div>
    <div id="profile-container"><p class="text-center py-12 text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>Laden...</p></div>
  </main>
  <script>
    const patientId = '${patientId}';
    const categoryNames = {metabolic_resistance:'Metabole Weerstand',thyroid:'Schildklier',hormonal:'PCOS/Hormonen',cortisol:'Cortisol',insulin:'Insuline',medication:'Medicatie',standard:'Standaard'};
    const catColors = {metabolic_resistance:'bg-red-100 text-red-700',thyroid:'bg-indigo-100 text-indigo-700',hormonal:'bg-pink-100 text-pink-700',cortisol:'bg-orange-100 text-orange-700',insulin:'bg-red-100 text-red-700',medication:'bg-blue-100 text-blue-700',standard:'bg-green-100 text-green-700'};
    const symptomLabels = {fatigue:'Vermoeidheid',sleep:'Slaapkwaliteit',digestion:'Spijsvertering',mood:'Stemming',pain:'Pijn',concentration:'Concentratie',hunger:'Hongergevoel'};
    const symptomIcons = {fatigue:'fa-battery-half',sleep:'fa-moon',digestion:'fa-stomach',mood:'fa-smile',pain:'fa-bolt',concentration:'fa-brain',hunger:'fa-utensils'};
    const symptomColors = {fatigue:'#ef4444',sleep:'#8b5cf6',digestion:'#f59e0b',mood:'#10b981',pain:'#ec4899',concentration:'#3b82f6',hunger:'#f97316'};

    let patientData = null;
    let progressData = [];
    let followUpsData = [];

    async function loadProfile() {
      try {
        const [patientRes, progressRes, followUpsRes] = await Promise.all([
          fetch('/api/patients/'+patientId),
          fetch('/api/progress/'+patientId),
          fetch('/api/follow-ups/'+patientId).catch(()=>({ok:false}))
        ]);
        patientData = await patientRes.json();
        const progressJson = await progressRes.json();
        progressData = Array.isArray(progressJson) ? progressJson : [];
        try { const fuJson = followUpsRes.ok ? await followUpsRes.json() : []; followUpsData = Array.isArray(fuJson) ? fuJson : []; } catch(e) { followUpsData = []; }

        const p = patientData;
        const age = p.date_of_birth ? Math.floor((Date.now()-new Date(p.date_of_birth).getTime())/31557600000) : '-';
        const genderLabel = {male:'Man',female:'Vrouw',other:'Anders'}[p.gender] || '-';
        const lastAssessment = (p.assessments||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
        const categories = lastAssessment?.categories || [];
        const catTags = categories.map(c=>'<span class="px-3 py-1 rounded-full text-sm font-semibold '+(catColors[c.id]||'bg-gray-100 text-gray-700')+'"><i class="fas '+c.icon+' mr-1"></i>'+(categoryNames[c.id]||c.name)+'</span>').join(' ');

        let html = '';
        // Header
        html += '<div class="bg-white rounded-xl shadow mb-6"><div class="bg-gradient-to-r from-primary-600 to-primary-800 text-white p-6 rounded-t-xl"><div class="flex items-center justify-between"><div><h2 class="text-2xl font-bold">'+p.first_name+' '+p.last_name+'</h2><p class="opacity-90">'+age+' jaar | '+genderLabel+' | '+( p.email||'Geen email')+'</p></div><div class="flex gap-2 flex-wrap">'+(lastAssessment?'':'<a href="/admin/triage/'+p.id+'" class="bg-white text-primary-700 px-4 py-2 rounded-lg font-semibold text-sm hover:bg-primary-50"><i class="fas fa-clipboard-check mr-1"></i>Start Triage</a>')+'<button onclick="generatePortalCode()" class="bg-green-500/30 hover:bg-green-500/50 text-white px-3 py-2 rounded-lg text-sm font-semibold border border-green-300/30"><i class="fas fa-key mr-1"></i>Portaal Code</button><button onclick="deletePatientPermanent()" class="bg-red-500/20 hover:bg-red-500/40 text-white px-3 py-2 rounded-lg text-sm font-semibold border border-red-300/30"><i class="fas fa-trash-alt mr-1"></i>Verwijder</button></div></div></div><div class="p-6"><div class="flex flex-wrap gap-2 items-center">'+( catTags||'<span class="text-gray-400">Nog geen assessment</span>')+'<span id="portal-code-badge" class="hidden ml-2 px-3 py-1 rounded-full text-sm font-mono font-bold bg-green-100 text-green-700 border border-green-300"><i class="fas fa-key mr-1"></i><span id="portal-code-value"></span></span></div></div></div>';

        // Assessment Historie
        const assessments = (p.assessments||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        html += '<div class="bg-white rounded-xl shadow mb-6"><div class="p-4 border-b flex items-center justify-between"><h3 class="font-bold text-lg"><i class="fas fa-clipboard-list mr-2 text-blue-600"></i>Assessment Historie ('+assessments.length+')</h3>'+(assessments.length?'<a href="/admin/triage/'+p.id+'" class="bg-blue-600 text-white px-3 py-1 rounded text-sm font-semibold hover:bg-blue-700"><i class="fas fa-plus mr-1"></i>Nieuwe Triage</a>':'')+'</div><div class="p-4">';
        if (!assessments.length) {
          html += '<div class="text-center py-6"><i class="fas fa-clipboard text-4xl text-gray-300 mb-3"></i><p class="text-gray-400 mb-3">Nog geen assessments afgenomen</p><a href="/admin/triage/'+p.id+'" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700"><i class="fas fa-clipboard-check mr-1"></i>Start eerste triage</a></div>';
        } else {
          html += '<div class="space-y-3">';
          assessments.forEach((a, idx) => {
            const aCats = (a.categories||[]);
            const aCatTags = aCats.map(c=>'<span class="px-2 py-0.5 rounded-full text-xs font-semibold '+(catColors[c.id]||'bg-gray-100 text-gray-700')+'">'+(categoryNames[c.id]||c.name)+'</span>').join(' ');
            const riskBadge = aCats.some(c=>c.risk==='high') ? '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">HOOG RISICO</span>' : aCats.some(c=>c.risk==='medium') ? '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">GEMIDDELD</span>' : '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">LAAG</span>';
            const date = new Date(a.created_at).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});
            const typeLabel = {quick:'Quick Triage',standard:'Standard Assessment',deep:'Deep Dive'}[a.assessment_type]||a.assessment_type;
            html += '<a href="/admin/assessment/'+p.id+'/'+a.id+'" class="block border rounded-xl p-4 hover:shadow-md transition card-hover '+(idx===0?'border-blue-200 bg-blue-50/30':'border-gray-200')+'"><div class="flex items-start justify-between"><div class="flex-1"><div class="flex items-center gap-2 mb-1"><span class="font-bold text-gray-800">'+typeLabel+'</span>'+(idx===0?'<span class="px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 font-semibold">Meest Recent</span>':'')+'</div><p class="text-sm text-gray-500 mb-2"><i class="far fa-calendar mr-1"></i>'+date+'</p><div class="flex flex-wrap gap-1">'+aCatTags+'</div></div><div class="flex flex-col items-end gap-2">'+riskBadge+'<span class="text-primary-600 text-sm font-semibold"><i class="fas fa-eye mr-1"></i>Bekijk details</span></div></div></a>';
          });
          html += '</div>';
        }
        html += '</div></div>';

        // Tabs content
        html += '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">';

        // Lab Tests with trend arrows & range bars
        const labs = (p.lab_tests||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        html += '<div class="bg-white rounded-xl shadow"><div class="p-4 border-b"><h3 class="font-bold text-lg"><i class="fas fa-flask mr-2 text-blue-600"></i>Lab-testen</h3></div><div class="p-4">';
        if (!labs.length) { html += '<p class="text-gray-400 text-center py-4">Geen lab-testen</p>'; }
        else {
          const completedLabs = labs.filter(l=>l.status==='completed' && l.interpretations?.length);
          labs.forEach(lab => {
            const statusBadge = {recommended:'bg-yellow-100 text-yellow-700',ordered:'bg-blue-100 text-blue-700',completed:'bg-green-100 text-green-700'}[lab.status]||'bg-gray-100';
            const statusLabel = {recommended:'Aanbevolen',ordered:'Aangevraagd',completed:'Voltooid'}[lab.status]||lab.status;
            html += '<div class="border rounded-lg p-3 mb-3"><div class="flex items-center justify-between mb-2"><span class="font-semibold text-sm">'+lab.test_package+'</span><div class="flex items-center gap-2"><span class="text-xs text-gray-400">'+new Date(lab.created_at).toLocaleDateString('nl-NL')+'</span><span class="px-2 py-1 rounded-full text-xs font-semibold '+statusBadge+'">'+statusLabel+'</span></div></div>';
            if (lab.status === 'recommended' || lab.status === 'ordered') {
              html += '<a href="/admin/lab-entry/'+patientId+'/'+lab.id+'" class="text-sm text-blue-600 hover:text-blue-800 font-semibold"><i class="fas fa-edit mr-1"></i>Resultaten invoeren</a>';
            }
            if (lab.status === 'completed' && lab.interpretations?.length) {
              html += '<div class="mt-2 space-y-2">';
              lab.interpretations.forEach(interp => {
                const statusIcon = interp.status==='optimal'?'<i class="fas fa-check-circle text-green-500"></i>':interp.status==='low'?'<i class="fas fa-arrow-down text-orange-500"></i>':'<i class="fas fa-arrow-up text-red-500"></i>';
                // Find previous value for trend arrow
                let trendArrow = '';
                const prevLab = completedLabs.find(pl => pl.id !== lab.id && pl.interpretations?.some(pi => pi.code === interp.code));
                if (prevLab) {
                  const prevInterp = prevLab.interpretations.find(pi => pi.code === interp.code);
                  if (prevInterp) {
                    const diff = interp.value - prevInterp.value;
                    if (Math.abs(diff) > 0.01) {
                      const improving = (interp.status === 'optimal') || (interp.status !== 'optimal' && prevInterp.status !== 'optimal' && Math.abs(diff) < Math.abs(prevInterp.value));
                      trendArrow = diff > 0
                        ? '<i class="fas fa-arrow-up text-xs '+(interp.status==='optimal'?'text-green-500':'text-red-400')+'" title="Gestegen t.o.v. vorige"></i>'
                        : '<i class="fas fa-arrow-down text-xs '+(interp.status==='optimal'?'text-green-500':'text-orange-400')+'" title="Gedaald t.o.v. vorige"></i>';
                    }
                  }
                }
                // Visual range bar
                const refRanges = {TSH:{min:0.4,max:2.5,absMax:8},fT4:{min:12,max:22,absMax:35},fT3:{min:4.0,max:6.5,absMax:10},INS:{min:2,max:6,absMax:25},HOMA:{min:0.5,max:2.0,absMax:5},CORT:{min:250,max:700,absMax:1200},FER:{min:30,max:100,absMax:500},VITD:{min:75,max:125,absMax:250},COQ10:{min:0.5,max:1.5,absMax:3},HBA1C:{min:4.0,max:5.6,absMax:12},CRP:{min:0,max:1.0,absMax:10},GLUC:{min:3.9,max:5.5,absMax:15},CHOL:{min:0,max:5.0,absMax:10},HDL:{min:1.0,max:99,absMax:99},LDL:{min:0,max:3.0,absMax:8},TG:{min:0,max:1.7,absMax:5},B12:{min:300,max:900,absMax:1500},HCY:{min:5,max:10,absMax:30},LEPT:{min:4,max:15,absMax:50},MG_RBC:{min:2.0,max:2.6,absMax:4},CALPRO:{min:0,max:50,absMax:500},ZONULIN:{min:0,max:107,absMax:300},PE1:{min:200,max:10000,absMax:10000},SIGA:{min:510,max:2040,absMax:3000},SCFA:{min:70,max:150,absMax:250},BGLUC:{min:0,max:1000,absMax:3000}};
                const ref = refRanges[interp.code];
                let rangeBar = '';
                if (ref) {
                  const absMax = ref.absMax || (ref.max * 2);
                  const minPct = (ref.min / absMax) * 100;
                  const maxPct = (ref.max / absMax) * 100;
                  const valPct = Math.min(Math.max((interp.value / absMax) * 100, 1), 99);
                  const barColor = interp.status==='optimal'?'bg-green-500':interp.status==='low'?'bg-orange-500':'bg-red-500';
                  rangeBar = '<div class="relative h-3 bg-gray-200 rounded-full mt-1 overflow-hidden"><div class="absolute h-full bg-green-200 rounded" style="left:'+minPct+'%;width:'+(maxPct-minPct)+'%"></div><div class="absolute h-full w-2 '+barColor+' rounded" style="left:calc('+valPct+'% - 4px)"></div></div>';
                }
                html += '<div class="p-2 rounded bg-gray-50"><div class="flex items-center gap-2 text-sm">'+statusIcon+' <span class="font-medium">'+interp.name+':</span> <span class="font-bold">'+interp.value+' '+interp.unit+'</span> '+trendArrow+(interp.alert?' <span class="text-xs text-red-600">('+interp.alert+')</span>':'')+'</div>'+rangeBar+'</div>';
              });
              html += '</div>';
            }
            html += '</div>';
          });
        }
        html += '</div></div>';

        // Protocols
        const protocols = (p.supplement_protocols||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        html += '<div class="bg-white rounded-xl shadow"><div class="p-4 border-b"><h3 class="font-bold text-lg"><i class="fas fa-pills mr-2 text-purple-600"></i>Protocollen</h3></div><div class="p-4">';
        if (!protocols.length) {
          html += '<p class="text-gray-400 text-center py-4">Geen protocollen</p>';
          if (lastAssessment) {
            html += '<div class="text-center"><button onclick="genProtocol()" class="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-green-700"><i class="fas fa-magic mr-1"></i>Genereer Protocol</button></div>';
          }
        } else {
          protocols.forEach(proto => {
            const supps = proto.supplements || [];
            html += '<div class="border rounded-lg p-3 mb-3"><div class="flex items-center justify-between mb-2"><span class="font-semibold text-sm">'+proto.protocol_type+'</span><span class="px-2 py-1 rounded-full text-xs font-semibold '+(proto.status==='active'?'bg-green-100 text-green-700':'bg-gray-100 text-gray-600')+'">'+proto.status+'</span></div>';
            html += '<a href="/admin/protocol/'+patientId+'/'+proto.id+'" class="text-sm text-purple-600 hover:text-purple-800 font-semibold"><i class="fas fa-eye mr-1"></i>Bekijk volledig protocol ('+supps.length+' supplementen)</a></div>';
          });
        }
        html += '</div></div>';

        html += '</div>'; // close grid

        // ==========================================
        // PROGRESS SECTION with 7 symptom scores + charts
        // ==========================================
        const progress = progressData.sort((a,b)=>new Date(a.measurement_date)-new Date(b.measurement_date));

        html += '<div class="bg-white rounded-xl shadow mt-6"><div class="p-4 border-b flex items-center justify-between"><h3 class="font-bold text-lg"><i class="fas fa-chart-line mr-2 text-teal-600"></i>Progressie & Symptomen</h3><button onclick="showProgressForm()" class="bg-teal-600 text-white px-3 py-1 rounded text-sm font-semibold hover:bg-teal-700"><i class="fas fa-plus mr-1"></i>Meting toevoegen</button></div><div class="p-4">';

        // Progress Form (hidden by default) - NOW with 7 symptom scores
        html += '<div id="progress-form" class="hidden mb-6 border rounded-xl p-5 bg-teal-50/50">';
        html += '<h4 class="font-bold text-lg mb-4 text-teal-800"><i class="fas fa-plus-circle mr-2"></i>Nieuwe Meting</h4>';
        html += '<form onsubmit="saveProgress(event)" class="space-y-4">';
        html += '<div class="grid grid-cols-2 md:grid-cols-4 gap-3">';
        html += '<div><label class="text-xs font-semibold text-gray-600 block mb-1">Datum *</label><input name="measurement_date" type="date" required class="w-full border rounded-lg px-3 py-2" value="'+new Date().toISOString().split('T')[0]+'"></div>';
        html += '<div><label class="text-xs font-semibold text-gray-600 block mb-1">Gewicht (kg)</label><input name="weight_kg" type="number" step="0.1" placeholder="Bijv. 82.5" class="w-full border rounded-lg px-3 py-2"></div>';
        html += '<div><label class="text-xs font-semibold text-gray-600 block mb-1">Buikomvang (cm)</label><input name="waist_cm" type="number" step="0.1" placeholder="Bijv. 95" class="w-full border rounded-lg px-3 py-2"></div>';
        html += '<div><label class="text-xs font-semibold text-gray-600 block mb-1">Energie (1-10)</label><input name="energy_level" type="number" min="1" max="10" placeholder="1=laag, 10=hoog" class="w-full border rounded-lg px-3 py-2"></div>';
        html += '</div>';
        // 7 Symptom scores
        html += '<div class="border-t pt-4 mt-2"><h5 class="font-bold text-sm text-gray-700 mb-3"><i class="fas fa-heartbeat mr-1 text-pink-500"></i>Symptoomscores (1 = ernstig, 10 = geen klachten)</h5>';
        html += '<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">';
        Object.entries(symptomLabels).forEach(([key, label]) => {
          html += '<div class="text-center"><label class="text-xs font-semibold text-gray-600 block mb-1"><i class="fas '+(symptomIcons[key]||'fa-circle')+' mr-1" style="color:'+symptomColors[key]+'"></i>'+label+'</label><input name="symptom_'+key+'" type="number" min="1" max="10" placeholder="1-10" class="w-full border rounded-lg px-2 py-2 text-center"></div>';
        });
        html += '</div></div>';
        html += '<div class="grid grid-cols-1 md:grid-cols-2 gap-3"><div><label class="text-xs font-semibold text-gray-600 block mb-1">Notities</label><input name="notes" placeholder="Opmerkingen..." class="w-full border rounded-lg px-3 py-2"></div><div class="flex items-end"><button type="submit" class="bg-teal-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-teal-700 w-full"><i class="fas fa-save mr-2"></i>Opslaan</button></div></div>';
        html += '</form></div>';

        if (!progress.length) {
          html += '<p class="text-gray-400 text-center py-4">Nog geen metingen</p>';
        } else {
          // Charts area
          html += '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">';
          html += '<div class="border rounded-xl p-4"><h4 class="font-bold text-sm text-gray-700 mb-2"><i class="fas fa-weight mr-1 text-blue-500"></i>Gewicht & BMI Trend</h4><canvas id="weightChart" height="200"></canvas></div>';
          html += '<div class="border rounded-xl p-4"><h4 class="font-bold text-sm text-gray-700 mb-2"><i class="fas fa-ruler mr-1 text-teal-500"></i>Buikomvang & Energie Trend</h4><canvas id="waistChart" height="200"></canvas></div>';
          html += '</div>';
          // Symptom radar + line chart
          html += '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">';
          html += '<div class="border rounded-xl p-4"><h4 class="font-bold text-sm text-gray-700 mb-2"><i class="fas fa-heartbeat mr-1 text-pink-500"></i>Symptomen Radar (meest recente meting)</h4><canvas id="symptomRadar" height="250"></canvas></div>';
          html += '<div class="border rounded-xl p-4"><h4 class="font-bold text-sm text-gray-700 mb-2"><i class="fas fa-chart-line mr-1 text-purple-500"></i>Symptoomtrends over Tijd</h4><canvas id="symptomLineChart" height="250"></canvas></div>';
          html += '</div>';

          // Data table with symptom columns
          html += '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left border-b bg-gray-50"><th class="p-2">Datum</th><th class="p-2">Gewicht</th><th class="p-2">Buik</th><th class="p-2">BMI</th><th class="p-2">Energie</th>';
          Object.values(symptomLabels).forEach(label => {
            html += '<th class="p-2 text-xs">'+label.substring(0,5)+'.</th>';
          });
          html += '<th class="p-2">Notities</th></tr></thead><tbody>';
          progress.forEach((m, idx) => {
            const symptoms = m.symptoms || {};
            const prevM = idx > 0 ? progress[idx-1] : null;
            const weightDiff = prevM && m.weight_kg && prevM.weight_kg ? (m.weight_kg - prevM.weight_kg).toFixed(1) : null;
            const weightTrend = weightDiff ? (weightDiff > 0 ? '<span class="text-red-500 text-xs ml-1">+'+weightDiff+'</span>' : weightDiff < 0 ? '<span class="text-green-500 text-xs ml-1">'+weightDiff+'</span>' : '') : '';
            html += '<tr class="border-b hover:bg-gray-50"><td class="p-2 font-medium">'+new Date(m.measurement_date).toLocaleDateString('nl-NL')+'</td>';
            html += '<td class="p-2">'+(m.weight_kg ? m.weight_kg+' kg'+weightTrend : '-')+'</td>';
            html += '<td class="p-2">'+(m.waist_cm||'-')+' cm</td>';
            // Calculate BMI if we have weight (assume height not available, show dash)
            html += '<td class="p-2 text-gray-400">-</td>';
            html += '<td class="p-2">'+(m.energy_level?'<span class="inline-flex items-center"><span class="w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center '+(m.energy_level>=7?'bg-green-100 text-green-700':m.energy_level>=4?'bg-yellow-100 text-yellow-700':'bg-red-100 text-red-700')+'">'+m.energy_level+'</span></span>':'-')+'</td>';
            Object.keys(symptomLabels).forEach(key => {
              const val = symptoms[key];
              if (val !== undefined && val !== null) {
                const color = val >= 7 ? 'bg-green-100 text-green-700' : val >= 4 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700';
                html += '<td class="p-2 text-center"><span class="inline-block w-6 h-6 rounded-full text-xs font-bold '+color+' leading-6">'+val+'</span></td>';
              } else {
                html += '<td class="p-2 text-center text-gray-300">-</td>';
              }
            });
            html += '<td class="p-2 text-gray-500 text-xs">'+(m.notes||'-')+'</td></tr>';
          });
          html += '</tbody></table></div>';
        }
        html += '</div></div>';

        // ==========================================
        // FOLLOW-UP PLANNING SECTION
        // ==========================================
        html += '<div class="bg-white rounded-xl shadow mt-6"><div class="p-4 border-b flex items-center justify-between"><h3 class="font-bold text-lg"><i class="fas fa-calendar-check mr-2 text-indigo-600"></i>Follow-up Planning</h3><button onclick="showFollowUpForm()" class="bg-indigo-600 text-white px-3 py-1 rounded text-sm font-semibold hover:bg-indigo-700"><i class="fas fa-plus mr-1"></i>Follow-up toevoegen</button></div><div class="p-4">';

        // Follow-up form (hidden)
        html += '<div id="followup-form" class="hidden mb-4 border rounded-xl p-5 bg-indigo-50/50">';
        html += '<h4 class="font-bold mb-3 text-indigo-800"><i class="fas fa-plus-circle mr-1"></i>Nieuwe Follow-up</h4>';
        html += '<form onsubmit="saveFollowUp(event)" class="grid grid-cols-1 md:grid-cols-3 gap-3">';
        html += '<div><label class="text-xs font-semibold text-gray-600 block mb-1">Datum *</label><input name="scheduled_date" type="date" required class="w-full border rounded-lg px-3 py-2"></div>';
        html += '<div><label class="text-xs font-semibold text-gray-600 block mb-1">Type *</label><select name="follow_up_type" required class="w-full border rounded-lg px-3 py-2"><option value="check_in">Check-in gesprek</option><option value="measurement">Meting + evaluatie</option><option value="lab_control">Lab-controle</option><option value="protocol_eval">Protocol evaluatie</option><option value="other">Anders</option></select></div>';
        html += '<div><label class="text-xs font-semibold text-gray-600 block mb-1">Doel</label><input name="goal" placeholder="Doel van deze follow-up..." class="w-full border rounded-lg px-3 py-2"></div>';
        html += '<div class="md:col-span-2"><label class="text-xs font-semibold text-gray-600 block mb-1">Notities</label><input name="notes" placeholder="Aanvullende notities..." class="w-full border rounded-lg px-3 py-2"></div>';
        html += '<div class="flex items-end"><button type="submit" class="bg-indigo-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-indigo-700 w-full"><i class="fas fa-save mr-1"></i>Opslaan</button></div>';
        html += '</form></div>';

        if (!followUpsData.length) {
          html += '<p class="text-gray-400 text-center py-4">Geen follow-ups gepland</p>';
        } else {
          const typeLabels = {check_in:'Check-in',measurement:'Meting',lab_control:'Lab-controle',protocol_eval:'Protocol evaluatie',other:'Anders'};
          const typeIcons = {check_in:'fa-comments',measurement:'fa-ruler',lab_control:'fa-flask',protocol_eval:'fa-clipboard-check',other:'fa-calendar'};
          const typeColors = {check_in:'bg-blue-100 text-blue-700',measurement:'bg-teal-100 text-teal-700',lab_control:'bg-yellow-100 text-yellow-700',protocol_eval:'bg-purple-100 text-purple-700',other:'bg-gray-100 text-gray-700'};
          const statusStyles = {scheduled:'bg-blue-100 text-blue-700',completed:'bg-green-100 text-green-700',cancelled:'bg-red-100 text-red-700',missed:'bg-orange-100 text-orange-700'};
          const statusLabels = {scheduled:'Gepland',completed:'Voltooid',cancelled:'Geannuleerd',missed:'Gemist'};

          html += '<div class="space-y-2">';
          followUpsData.forEach(fu => {
            const dateStr = new Date(fu.scheduled_date).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric'});
            const isPast = new Date(fu.scheduled_date) < new Date() && fu.status === 'scheduled';
            const fuType = fu.follow_up_type || 'other';
            html += '<div class="flex items-center gap-3 border rounded-lg p-3 '+(isPast?'bg-orange-50 border-orange-200':'hover:bg-gray-50')+'">';
            html += '<div class="w-10 h-10 rounded-full '+(typeColors[fuType]||'bg-gray-100')+' flex items-center justify-center flex-shrink-0"><i class="fas '+(typeIcons[fuType]||'fa-calendar')+'"></i></div>';
            html += '<div class="flex-1"><div class="flex items-center gap-2"><span class="font-semibold text-sm">'+(typeLabels[fuType]||fuType)+'</span><span class="px-2 py-0.5 rounded-full text-xs font-semibold '+(statusStyles[fu.status]||'bg-gray-100')+'">'+(statusLabels[fu.status]||fu.status)+'</span>'+(isPast?'<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-200 text-orange-800">Achterstallig</span>':'')+'</div>';
            html += '<p class="text-sm text-gray-500"><i class="far fa-calendar mr-1"></i>'+dateStr+(fu.goal?' | <i class="fas fa-bullseye mr-1"></i>'+fu.goal:'')+'</p>';
            if (fu.notes) html += '<p class="text-xs text-gray-400 mt-1">'+fu.notes+'</p>';
            html += '</div>';
            // Action buttons
            if (fu.status === 'scheduled') {
              html += '<div class="flex gap-1 flex-shrink-0">';
              html += '<button onclick="updateFollowUp(\\''+fu.id+'\\',\\'completed\\')" class="text-green-600 hover:text-green-800 text-sm p-1" title="Markeer als voltooid"><i class="fas fa-check-circle"></i></button>';
              html += '<button onclick="updateFollowUp(\\''+fu.id+'\\',\\'cancelled\\')" class="text-red-400 hover:text-red-600 text-sm p-1" title="Annuleren"><i class="fas fa-times-circle"></i></button>';
              html += '</div>';
            }
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</div></div>';

        document.getElementById('profile-container').innerHTML = html;

        // Render charts after DOM update
        if (progress.length >= 1) {
          setTimeout(() => renderCharts(progress), 100);
        }
      } catch(e) {
        console.error(e);
        document.getElementById('profile-container').innerHTML = '<p class="text-red-500 text-center py-12">Fout: '+e.message+'</p>';
      }
    }

    function renderCharts(progress) {
      const labels = progress.map(m => new Date(m.measurement_date).toLocaleDateString('nl-NL',{day:'numeric',month:'short'}));

      // 1. Weight Chart
      const weightCtx = document.getElementById('weightChart');
      if (weightCtx) {
        new Chart(weightCtx, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Gewicht (kg)',
              data: progress.map(m => m.weight_kg || null),
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.1)',
              fill: true,
              tension: 0.3,
              spanGaps: true,
              pointRadius: 4,
              pointBackgroundColor: '#3b82f6'
            }]
          },
          options: {
            responsive: true,
            plugins: { legend: { display: true, position: 'top' } },
            scales: {
              y: { beginAtZero: false, title: { display: true, text: 'kg' } }
            }
          }
        });
      }

      // 2. Waist + Energy Chart
      const waistCtx = document.getElementById('waistChart');
      if (waistCtx) {
        new Chart(waistCtx, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Buikomvang (cm)',
              data: progress.map(m => m.waist_cm || null),
              borderColor: '#14b8a6',
              backgroundColor: 'rgba(20,184,166,0.1)',
              fill: true,
              tension: 0.3,
              spanGaps: true,
              yAxisID: 'y',
              pointRadius: 4
            },{
              label: 'Energie (1-10)',
              data: progress.map(m => m.energy_level || null),
              borderColor: '#f59e0b',
              borderDash: [5,5],
              tension: 0.3,
              spanGaps: true,
              yAxisID: 'y1',
              pointRadius: 4,
              pointBackgroundColor: '#f59e0b'
            }]
          },
          options: {
            responsive: true,
            plugins: { legend: { display: true, position: 'top' } },
            scales: {
              y: { beginAtZero: false, position: 'left', title: { display: true, text: 'cm' } },
              y1: { beginAtZero: true, min: 0, max: 10, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'score' } }
            }
          }
        });
      }

      // 3. Symptom Radar (latest measurement with symptoms)
      const radarCtx = document.getElementById('symptomRadar');
      const latestWithSymptoms = [...progress].reverse().find(m => m.symptoms && Object.keys(m.symptoms).length > 0);
      if (radarCtx && latestWithSymptoms) {
        const symKeys = Object.keys(symptomLabels);
        const symValues = symKeys.map(k => latestWithSymptoms.symptoms[k] || 0);
        new Chart(radarCtx, {
          type: 'radar',
          data: {
            labels: symKeys.map(k => symptomLabels[k]),
            datasets: [{
              label: 'Score (10=geen klachten)',
              data: symValues,
              backgroundColor: 'rgba(139,92,246,0.2)',
              borderColor: '#8b5cf6',
              pointBackgroundColor: symKeys.map(k => symptomColors[k]),
              pointRadius: 5,
              borderWidth: 2
            }]
          },
          options: {
            responsive: true,
            scales: {
              r: { min: 0, max: 10, ticks: { stepSize: 2 }, pointLabels: { font: { size: 11, weight: 'bold' } } }
            },
            plugins: { legend: { display: false } }
          }
        });
      } else if (radarCtx) {
        radarCtx.parentElement.innerHTML += '<p class="text-gray-400 text-center text-sm mt-4">Nog geen symptoomscores ingevuld</p>';
      }

      // 4. Symptom Line Chart (trends over time)
      const lineCtx = document.getElementById('symptomLineChart');
      const measWithSymptoms = progress.filter(m => m.symptoms && Object.keys(m.symptoms).length > 0);
      if (lineCtx && measWithSymptoms.length >= 1) {
        const symLabelsArr = measWithSymptoms.map(m => new Date(m.measurement_date).toLocaleDateString('nl-NL',{day:'numeric',month:'short'}));
        const datasets = Object.keys(symptomLabels).map(key => ({
          label: symptomLabels[key],
          data: measWithSymptoms.map(m => (m.symptoms && m.symptoms[key]) || null),
          borderColor: symptomColors[key],
          backgroundColor: symptomColors[key]+'20',
          tension: 0.3,
          spanGaps: true,
          pointRadius: 3,
          borderWidth: 2
        }));
        new Chart(lineCtx, {
          type: 'line',
          data: { labels: symLabelsArr, datasets },
          options: {
            responsive: true,
            plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } },
            scales: {
              y: { min: 0, max: 10, title: { display: true, text: 'Score (10=goed)' }, ticks: { stepSize: 2 } }
            }
          }
        });
      } else if (lineCtx) {
        lineCtx.parentElement.innerHTML += '<p class="text-gray-400 text-center text-sm mt-4">Nog geen symptoomscores beschikbaar voor trendweergave</p>';
      }
    }

    function showProgressForm() { document.getElementById('progress-form').classList.toggle('hidden'); }
    function showFollowUpForm() { document.getElementById('followup-form').classList.toggle('hidden'); }

    async function saveProgress(e) {
      e.preventDefault();
      const form = e.target;
      const formData = new FormData(form);
      const data = { patient_id: patientId };

      // Extract base fields
      data.measurement_date = formData.get('measurement_date');
      if (formData.get('weight_kg')) data.weight_kg = parseFloat(formData.get('weight_kg'));
      if (formData.get('waist_cm')) data.waist_cm = parseFloat(formData.get('waist_cm'));
      if (formData.get('energy_level')) data.energy_level = parseInt(formData.get('energy_level'));
      if (formData.get('notes')) data.notes = formData.get('notes');

      // Extract symptom scores into JSONB
      const symptoms = {};
      Object.keys(symptomLabels).forEach(key => {
        const val = formData.get('symptom_'+key);
        if (val) symptoms[key] = parseInt(val);
      });
      if (Object.keys(symptoms).length > 0) data.symptoms = symptoms;

      try {
        const res = await fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
        if(res.ok) loadProfile();
        else { const err = await res.json(); alert('Fout: '+(err.error||'Onbekend')); }
      } catch(e){alert(e.message);}
    }

    async function saveFollowUp(e) {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      data.patient_id = patientId;
      data.status = 'scheduled';
      Object.keys(data).forEach(k => { if (!data[k]) delete data[k]; });
      try {
        const res = await fetch('/api/follow-ups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
        if(res.ok) loadProfile();
        else { const err = await res.json(); alert('Fout: '+(err.error||'Onbekend')); }
      } catch(e){alert(e.message);}
    }

    async function updateFollowUp(id, status) {
      try {
        const res = await fetch('/api/follow-ups/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status, completed_date: status==='completed'?new Date().toISOString().split('T')[0]:null})});
        if(res.ok) loadProfile();
        else alert('Fout bij updaten');
      } catch(e){alert(e.message);}
    }

    async function genProtocol() {
      const res = await fetch('/api/patients/'+patientId);
      const p = await res.json();
      const lastA = (p.assessments||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
      if(!lastA) return alert('Geen assessment gevonden');
      const cats = (lastA.categories||[]).map(c=>c.id);
      const pRes = await fetch('/api/protocols',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patient_id:patientId,assessment_id:lastA.id,categories:cats})});
      if(pRes.ok) loadProfile();
      else alert('Fout bij protocol generatie');
    }

    async function deletePatientPermanent() {
      const name = patientData ? patientData.first_name + ' ' + patientData.last_name : '';
      if (!confirm('Weet je zeker dat je "' + name + '" definitief wilt verwijderen?\\n\\nAlle bijbehorende data (assessments, lab-testen, protocollen, progressie) wordt ook verwijderd.\\n\\nDit kan NIET ongedaan worden gemaakt!')) return;
      try {
        const res = await fetch('/api/patients/' + patientId + '/permanent', { method: 'DELETE' });
        if (res.ok) { window.location.href = '/admin'; }
        else { const err = await res.json(); alert('Fout: ' + (err.error || 'Onbekend')); }
      } catch(e) { alert('Fout: ' + e.message); }
    }

    async function generatePortalCode() {
      const name = patientData ? patientData.first_name + ' ' + patientData.last_name : '';
      // Check if code already exists
      try {
        const checkRes = await fetch('/api/patients/' + patientId + '/portal-code');
        const checkData = await checkRes.json();
        if (checkData.portal_code) {
          const action = confirm('Er is al een actieve portaalcode voor ' + name + ':\\n\\n' + checkData.portal_code + '\\n\\nWilt u een NIEUWE code genereren? (de oude code werkt dan niet meer)');
          if (!action) {
            // Just show existing code
            document.getElementById('portal-code-badge').classList.remove('hidden');
            document.getElementById('portal-code-value').textContent = checkData.portal_code;
            return;
          }
        }
      } catch(e) {}
      
      try {
        const res = await fetch('/api/portal/generate-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patient_id: patientId })
        });
        const data = await res.json();
        if (res.ok) {
          document.getElementById('portal-code-badge').classList.remove('hidden');
          document.getElementById('portal-code-value').textContent = data.code;
          alert('Portaalcode gegenereerd voor ' + name + ':\\n\\n' + data.code + '\\n\\nDe patiënt kan hiermee inloggen op:\\n' + window.location.origin + '/');
        } else {
          alert('Fout: ' + (data.error || 'Onbekend'));
        }
      } catch(e) { alert('Fout: ' + e.message); }
    }

    // Check for existing portal code on load
    async function checkPortalCode() {
      try {
        const res = await fetch('/api/patients/' + patientId + '/portal-code');
        const data = await res.json();
        if (data.portal_code) {
          document.getElementById('portal-code-badge').classList.remove('hidden');
          document.getElementById('portal-code-value').textContent = data.portal_code;
        }
      } catch(e) {}
    }

    loadProfile();
    checkPortalCode();
  </script>
</body></html>`)
})

// LAB RESULTS ENTRY PAGE (Bloed + Ontlasting)
app.get('/admin/lab-entry/:patientId/:labId', (c) => {
  const patientId = c.req.param('patientId')
  const labId = c.req.param('labId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-4xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/admin/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
    <div class="bg-white rounded-xl shadow">
      <div class="bg-gradient-to-r from-green-500 to-teal-500 text-white p-6 rounded-t-xl">
        <h2 class="text-2xl font-bold"><i class="fas fa-vial mr-2"></i>Lab-resultaten Invoeren</h2>
        <p class="opacity-90 mt-1">Voer bloed- en ontlastingswaarden in voor automatische interpretatie</p>
      </div>
      <div id="lab-form-container" class="p-6">
        <p class="text-center py-8 text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>Laden...</p>
      </div>
    </div>
  </main>
  <script>
    const patientId = '${patientId}';
    const labId = '${labId}';

    const refRanges = {
      // Bloed
      TSH:{unit:'mU/L',min:0.4,max:2.5},fT4:{unit:'pmol/L',min:12,max:22},fT3:{unit:'pmol/L',min:4.0,max:6.5},
      INS:{unit:'mU/L',min:2,max:6},HOMA:{unit:'',min:0.5,max:2.0},CORT:{unit:'nmol/L',min:250,max:700},
      FER:{unit:'µg/L',min:30,max:100},VITD:{unit:'nmol/L',min:75,max:125},COQ10:{unit:'µmol/L',min:0.5,max:1.5},
      HBA1C:{unit:'%',min:4.0,max:5.6},CRP:{unit:'mg/L',min:0,max:1.0},GLUC:{unit:'mmol/L',min:3.9,max:5.5},
      CHOL:{unit:'mmol/L',min:0,max:5.0},HDL:{unit:'mmol/L',min:1.0,max:99},LDL:{unit:'mmol/L',min:0,max:3.0},
      TG:{unit:'mmol/L',min:0,max:1.7},B12:{unit:'pmol/L',min:300,max:900},HCY:{unit:'µmol/L',min:5,max:10},
      LEPT:{unit:'ng/mL',min:4,max:15},MG_RBC:{unit:'mmol/L',min:2.0,max:2.6},
      ALAT:{unit:'U/L',min:0,max:35},ASAT:{unit:'U/L',min:0,max:35},GGT:{unit:'U/L',min:0,max:40},
      HB:{unit:'mmol/L',min:7.5,max:10.0},MCV:{unit:'fL',min:80,max:100},CREA:{unit:'µmol/L',min:50,max:100},
      DHEAS:{unit:'µmol/L',min:2.5,max:10},TESTO:{unit:'nmol/L',min:0.3,max:2.0},
      SHBG:{unit:'nmol/L',min:30,max:120},SE:{unit:'µg/L',min:70,max:150},ZN:{unit:'µmol/L',min:11,max:18},
      CR:{unit:'nmol/L',min:1.5,max:7.0},CK:{unit:'U/L',min:25,max:200},FOL:{unit:'nmol/L',min:10,max:45},
      // Ontlasting
      CALPRO:{unit:'µg/g',min:0,max:50},ZONULIN:{unit:'ng/mL',min:0,max:107},
      PE1:{unit:'µg/g',min:200,max:10000},SIGA:{unit:'µg/mL',min:510,max:2040},
      SCFA:{unit:'µmol/g',min:70,max:150},BGLUC:{unit:'U/mL',min:0,max:1000},
    };

    function renderTestInput(t, ref) {
      const typeIcon = t.type==='stool'?'<i class="fas fa-vial text-amber-500 mr-1"></i>':t.type==='urine'?'<i class="fas fa-tint text-yellow-500 mr-1"></i>':t.type==='saliva'?'<i class="fas fa-tint text-blue-400 mr-1"></i>':'<i class="fas fa-tint text-red-400 mr-1"></i>';
      const bgClass = t.type==='stool'?'bg-amber-50/50':t.type==='urine'?'bg-yellow-50/30':'';
      return '<div class="flex items-center gap-4 border-b pb-3 '+bgClass+' p-2 rounded"><div class="flex-1"><label class="block text-sm font-semibold text-gray-700">'+typeIcon+t.name+'</label>'+(ref?'<span class="text-xs text-gray-400">Optimaal: '+ref.min+' - '+ref.max+' '+ref.unit+'</span>':'<span class="text-xs text-gray-300">Geen referentie</span>')+(t.note?'<span class="text-xs text-blue-500 block">'+t.note+'</span>':'')+(t.rationale?'<span class="text-xs text-gray-400 block italic">'+t.rationale.substring(0,80)+'...</span>':'')+'</div><div class="w-40"><input name="'+t.code+'" type="number" step="0.01" class="w-full border rounded px-3 py-2 text-right" placeholder="Waarde"></div><span class="text-sm text-gray-400 w-20">'+(ref?ref.unit:'')+'</span></div>';
    }

    async function loadLabForm() {
      try {
        const res = await fetch('/api/lab-tests/'+patientId);
        const labs = await res.json();
        const lab = labs.find(l=>l.id===labId);
        if(!lab) { document.getElementById('lab-form-container').innerHTML='<p class="text-red-500">Lab test niet gevonden</p>'; return; }

        const allTests = lab.recommended_tests || [];
        const bloodTests = allTests.filter(t=>t.type==='blood'||!t.type);
        const stoolTests = allTests.filter(t=>t.type==='stool');
        const otherTests = allTests.filter(t=>t.type&&!['blood','stool'].includes(t.type));

        let html = '<form onsubmit="submitResults(event)" class="space-y-6">';
        html += '<div class="bg-blue-50 border-l-4 border-blue-500 p-4 rounded"><p class="text-sm text-blue-700"><i class="fas fa-info-circle mr-1"></i>Voer alleen de waarden in die beschikbaar zijn. De <strong>optimale</strong> range wordt getoond (niet de standaard lab referentie).</p></div>';

        // BLOED
        if (bloodTests.length) {
          const reqBlood = bloodTests.filter(t=>t.required);
          const optBlood = bloodTests.filter(t=>!t.required);
          html += '<div><h3 class="font-bold text-lg flex items-center mb-3"><i class="fas fa-tint mr-2 text-red-500"></i>Bloedonderzoek ('+bloodTests.length+' testen)</h3>';
          if (reqBlood.length) {
            html += '<h4 class="text-sm font-semibold text-gray-600 mb-2">Verplicht ('+reqBlood.length+')</h4><div class="space-y-2">';
            reqBlood.forEach(t => { html += renderTestInput(t, refRanges[t.code]); });
            html += '</div>';
          }
          if (optBlood.length) {
            html += '<details class="mt-4"><summary class="cursor-pointer text-sm font-semibold text-gray-600 hover:text-gray-800 mb-2"><i class="far fa-circle mr-1"></i>Optioneel ('+optBlood.length+') - klik om te tonen</summary><div class="space-y-2">';
            optBlood.forEach(t => { html += renderTestInput(t, refRanges[t.code]); });
            html += '</div></details>';
          }
          html += '</div>';
        }

        // ONTLASTING
        if (stoolTests.length) {
          const reqStool = stoolTests.filter(t=>t.required);
          const optStool = stoolTests.filter(t=>!t.required);
          html += '<div class="border-t pt-6"><h3 class="font-bold text-lg flex items-center mb-3"><i class="fas fa-vial mr-2 text-amber-600"></i>Ontlastingsonderzoek ('+stoolTests.length+' testen)</h3>';
          html += '<div class="bg-amber-50 border-l-4 border-amber-500 p-3 rounded mb-3 text-sm text-amber-800"><i class="fas fa-info-circle mr-1"></i>Ontlastingsonderzoek wordt door gespecialiseerd lab verwerkt. Resultaten kunnen 1-2 weken duren.</div>';
          if (reqStool.length) {
            html += '<h4 class="text-sm font-semibold text-gray-600 mb-2">Verplicht ('+reqStool.length+')</h4><div class="space-y-2">';
            reqStool.forEach(t => { html += renderTestInput(t, refRanges[t.code]); });
            html += '</div>';
          }
          if (optStool.length) {
            html += '<details class="mt-4"><summary class="cursor-pointer text-sm font-semibold text-gray-600 hover:text-gray-800 mb-2"><i class="far fa-circle mr-1"></i>Optioneel ('+optStool.length+')</summary><div class="space-y-2">';
            optStool.forEach(t => { html += renderTestInput(t, refRanges[t.code]); });
            html += '</div></details>';
          }
          html += '</div>';
        }

        // OVERIG
        if (otherTests.length) {
          html += '<div class="border-t pt-6"><h3 class="font-bold text-lg flex items-center mb-3"><i class="fas fa-microscope mr-2 text-purple-600"></i>Overig ('+otherTests.length+' testen)</h3><div class="space-y-2">';
          otherTests.forEach(t => { html += renderTestInput(t, refRanges[t.code]); });
          html += '</div></div>';
        }

        html += '<div class="flex gap-4 mt-6 border-t pt-6"><button type="submit" class="bg-green-600 text-white px-8 py-3 rounded-lg font-bold hover:bg-green-700"><i class="fas fa-save mr-2"></i>Opslaan & Interpreteer</button><a href="/admin/patient/'+patientId+'" class="px-6 py-3 rounded-lg border text-gray-600 hover:bg-gray-50">Annuleren</a></div></form>';

        document.getElementById('lab-form-container').innerHTML = html;
      } catch(e) {
        document.getElementById('lab-form-container').innerHTML='<p class="text-red-500">Fout: '+e.message+'</p>';
      }
    }

    async function submitResults(e) {
      e.preventDefault();
      const formData = new FormData(e.target);
      const results = {};
      for(const [key,val] of formData) { if(val) results[key] = parseFloat(val); }
      if(!Object.keys(results).length) { alert('Voer minimaal één waarde in'); return; }

      try {
        const res = await fetch('/api/lab-tests/'+labId+'/results', {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({results})
        });
        const data = await res.json();
        if(res.ok) { window.location.href = '/admin/patient/'+patientId; }
        else alert('Fout: '+(data.error||'Onbekend'));
      } catch(e) { alert('Fout: '+e.message); }
    }

    loadLabForm();
  </script>
</body></html>`)
})

// ASSESSMENT DETAIL PAGE - Volledige vragenlijst teruglezen
app.get('/admin/assessment/:patientId/:assessmentId', (c) => {
  const patientId = c.req.param('patientId')
  const assessmentId = c.req.param('assessmentId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-4xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/admin/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
    <div id="assessment-detail"><p class="text-center py-12 text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>Assessment laden...</p></div>
  </main>
  <script>
    const patientId = '${patientId}';
    const assessmentId = '${assessmentId}';

    const questionLabels = {
      gender: { text: 'Wat is uw geslacht?', indicator: 'Basis', icon: 'fa-venus-mars' },
      age: { text: 'Wat is uw leeftijd?', indicator: 'Basis', icon: 'fa-birthday-cake' },
      duration_trying: { text: 'Hoe lang probeert u al af te vallen?', indicator: 'Metabole weerstand', icon: 'fa-clock' },
      weight_loss_success: { text: 'Valt u af ondanks calorierestrictie en beweging?', indicator: 'Metabole weerstand', icon: 'fa-weight' },
      fatigue_cold_dry: { text: 'Bent u vaak moe, heeft u het vaak koud en heeft u droge huid?', indicator: 'Schildklier', icon: 'fa-thermometer-half' },
      menstrual_regularity: { text: 'Is uw menstruatiecyclus regelmatig?', indicator: 'PCOS/Hormonen', icon: 'fa-venus' },
      stress_frequency: { text: 'Ervaart u regelmatig stress of angst?', indicator: 'Cortisol', icon: 'fa-brain' },
      sleep_quality: { text: 'Hoe is uw slaap?', indicator: 'Cortisol/Leptine', icon: 'fa-moon' },
      medication_use: { text: 'Welke medicijnen gebruikt u?', indicator: 'Medicatie', icon: 'fa-pills' },
      statin_side_effects: { text: 'Heeft u last van spierpijn of vermoeidheid bij statinegebruik?', indicator: 'CoQ10', icon: 'fa-heartbeat' },
      hunger_after_meal: { text: 'Heeft u honger kort na een maaltijd (< 2 uur)?', indicator: 'Insuline', icon: 'fa-utensils' },
      fat_distribution: { text: 'Waar zit het meeste vet bij u?', indicator: 'Hormonale distributie', icon: 'fa-male' },
      sugar_cravings: { text: 'Heeft u sterke cravings voor suiker/zoet?', indicator: 'Insuline/Serotonine', icon: 'fa-candy-cane' },
      menopause_status: { text: 'Bent u in de overgang of postmenopauzaal?', indicator: 'Oestrogeen', icon: 'fa-female' },
      diagnosed_conditions: { text: 'Heeft u een diagnose van:', indicator: 'Pathologie', icon: 'fa-stethoscope' }
    };

    const answerLabels = {
      gender: { male:'Man', female:'Vrouw', other:'Anders' },
      duration_trying: { less_3_months:'Minder dan 3 maanden', '3_6_months':'3-6 maanden', '6_12_months':'6-12 maanden', over_1_year:'Meer dan 1 jaar' },
      weight_loss_success: { easy:'Ja, moeiteloos', slow:'Langzaam maar wel', barely:'Nauwelijks / plateau', none:'Nee, geen resultaat' },
      fatigue_cold_dry: { yes:'Ja, regelmatig tot dagelijks', sometimes:'Soms, maar niet altijd', no:'Nee, dit herken ik niet' },
      menstrual_regularity: { yes:'Ja, regelmatig', irregular:'Onregelmatig', no:'Nee', na:'Niet van toepassing' },
      stress_frequency: { daily:'Dagelijks', weekly:'Wekelijks', rarely:'Zelden', never:'Nooit' },
      sleep_quality: { excellent:'Uitstekend (7-9 uur doorslapen)', fair:'Redelijk (wordt soms wakker)', moderate:'Matig (moeite met inslapen)', poor:'Slecht (< 6 uur of zeer onrustig)' },
      medication_use: { none:'Geen medicijnen', thyroid_med:'Schildkliermedicatie', statins:'Statines (cholesterol)', diabetes_med:'Diabetesmedicatie', antidepressants:'Antidepressiva', beta_blockers:'Betablokkers', other:'Anders' },
      statin_side_effects: { yes:'Ja', no:'Nee', no_statins:'Gebruik geen statines' },
      hunger_after_meal: { always:'Altijd', often:'Vaak', sometimes:'Soms', never:'Nooit' },
      fat_distribution: { belly:'Buik (visceraal)', hips_legs:'Heupen/benen', even:'Gelijkmatig verdeeld', unsure:'Onzeker' },
      sugar_cravings: { daily:'Dagelijks', regularly:'Regelmatig', rarely:'Zelden', never:'Nooit' },
      menopause_status: { yes:'Ja', no:'Nee', unsure:'Weet niet', na:'Niet van toepassing' },
      diagnosed_conditions: { diabetes:'Diabetes type 2', pcos:'PCOS', hashimoto:'Hashimoto', thyroid:'Andere schildklieraandoening', none:'Geen van bovenstaande' }
    };

    const categoryNames = {metabolic_resistance:'Metabole Weerstand',thyroid:'Schildklier',hormonal:'PCOS/Hormonen',cortisol:'Cortisol',insulin:'Insuline',medication:'Medicatie',standard:'Standaard'};
    const catColors = {metabolic_resistance:'bg-red-100 text-red-700 border-red-300',thyroid:'bg-indigo-100 text-indigo-700 border-indigo-300',hormonal:'bg-pink-100 text-pink-700 border-pink-300',cortisol:'bg-orange-100 text-orange-700 border-orange-300',insulin:'bg-red-100 text-red-700 border-red-300',medication:'bg-blue-100 text-blue-700 border-blue-300',standard:'bg-green-100 text-green-700 border-green-300'};
    const riskColors = {high:'bg-red-50 border-red-500',medium:'bg-orange-50 border-orange-500',low:'bg-green-50 border-green-500'};
    const riskLabels = {high:'HOOG RISICO',medium:'GEMIDDELD RISICO',low:'LAAG RISICO'};
    const riskTextColors = {high:'text-red-700',medium:'text-orange-700',low:'text-green-700'};

    // Color coding for answer severity
    function getAnswerSeverity(qId, answer) {
      const severeAnswers = {
        weight_loss_success: ['none','barely'],
        fatigue_cold_dry: ['yes'],
        menstrual_regularity: ['irregular','no'],
        stress_frequency: ['daily'],
        sleep_quality: ['poor'],
        statin_side_effects: ['yes'],
        hunger_after_meal: ['always','often'],
        sugar_cravings: ['daily','regularly'],
        duration_trying: ['over_1_year','6_12_months']
      };
      const moderateAnswers = {
        weight_loss_success: ['slow'],
        fatigue_cold_dry: ['sometimes'],
        stress_frequency: ['weekly'],
        sleep_quality: ['moderate','fair'],
        hunger_after_meal: ['sometimes'],
        sugar_cravings: ['rarely'],
        duration_trying: ['3_6_months']
      };
      if (severeAnswers[qId] && (Array.isArray(answer) ? answer.some(a=>severeAnswers[qId].includes(a)) : severeAnswers[qId].includes(answer))) return 'severe';
      if (moderateAnswers[qId] && (Array.isArray(answer) ? answer.some(a=>moderateAnswers[qId].includes(a)) : moderateAnswers[qId].includes(answer))) return 'moderate';
      return 'normal';
    }

    async function loadAssessmentDetail() {
      try {
        const [patientRes, assessmentRes] = await Promise.all([
          fetch('/api/patients/'+patientId),
          fetch('/api/assessments/'+assessmentId)
        ]);
        const patient = await patientRes.json();
        const assessment = await assessmentRes.json();
        const responses = assessment.responses || {};
        const categories = assessment.categories || [];
        const riskScores = assessment.risk_scores || {};
        const typeLabel = {quick:'Quick Triage',standard:'Standard Assessment',deep:'Deep Dive'}[assessment.assessment_type]||assessment.assessment_type;
        const date = new Date(assessment.created_at).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});

        let html = '';

        // Review status
        const reviewStatus = assessment.review_status || 'pending_review';
        const reviewBadge = reviewStatus === 'reviewed' 
          ? '<span class="bg-green-500/30 text-green-100 px-3 py-1 rounded-full text-xs font-bold"><i class="fas fa-check-circle mr-1"></i>Beoordeeld</span>'
          : reviewStatus === 'needs_followup'
          ? '<span class="bg-yellow-500/30 text-yellow-100 px-3 py-1 rounded-full text-xs font-bold"><i class="fas fa-exclamation-circle mr-1"></i>Vervolg nodig</span>'
          : '<span class="bg-orange-500/30 text-orange-100 px-3 py-1 rounded-full text-xs font-bold"><i class="fas fa-hourglass-half mr-1"></i>Wacht op beoordeling</span>';

        // Header
        html += '<div class="bg-white rounded-xl shadow mb-6"><div class="bg-gradient-to-r from-blue-600 to-cyan-600 text-white p-6 rounded-t-xl"><div class="flex items-center justify-between"><div><h2 class="text-2xl font-bold"><i class="fas fa-clipboard-list mr-2"></i>'+typeLabel+': '+patient.first_name+' '+patient.last_name+'</h2><p class="opacity-90 mt-1"><i class="far fa-calendar mr-1"></i> '+date+' &nbsp; '+reviewBadge+'</p></div><div class="flex gap-2"><a href="/admin/results/'+patientId+'/'+assessmentId+'" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-semibold"><i class="fas fa-chart-bar mr-1"></i>Resultaten</a><button onclick="window.print()" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-semibold"><i class="fas fa-print mr-1"></i>Print</button></div></div></div>';

        // Review actie balk
        if (reviewStatus !== 'reviewed') {
          html += '<div class="bg-amber-50 border-b border-amber-200 p-4 flex items-center justify-between flex-wrap gap-3">';
          html += '<div class="flex items-center gap-2"><i class="fas fa-user-check text-amber-600"></i><span class="text-sm font-semibold text-amber-800">Deze assessment wacht op jouw beoordeling. De patiënt kan de resultaten nog niet zien.</span></div>';
          html += '<div class="flex gap-2">';
          html += '<button onclick="markReviewed()" id="review-btn" class="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-green-700 transition"><i class="fas fa-check-circle mr-1"></i>Beoordeling vrijgeven</button>';
          html += '<button onclick="markFollowup()" class="bg-yellow-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-yellow-600 transition"><i class="fas fa-exclamation-circle mr-1"></i>Vervolg nodig</button>';
          html += '</div></div>';
        } else {
          html += '<div class="bg-green-50 border-b border-green-200 p-4 flex items-center gap-2">';
          html += '<i class="fas fa-check-circle text-green-600"></i><span class="text-sm font-semibold text-green-800">Beoordeeld'+(assessment.reviewed_at ? ' op '+new Date(assessment.reviewed_at).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '')+' — patiënt kan de resultaten nu bekijken.</span>';
          html += '<button onclick="undoReview()" class="ml-auto text-xs text-green-600 hover:text-green-800 underline">Intrekken</button>';
          html += '</div>';
        }

        // Categorisering samenvatting
        html += '<div class="p-6 border-b"><h3 class="font-bold text-lg mb-3"><i class="fas fa-tags mr-2 text-primary-600"></i>Categorisering</h3><div class="flex flex-wrap gap-2 mb-4">';
        categories.forEach(cat => {
          html += '<div class="border rounded-lg px-4 py-2 '+(catColors[cat.id]||'bg-gray-100 text-gray-700')+' flex items-center gap-2"><i class="fas '+cat.icon+'"></i><span class="font-bold">'+(categoryNames[cat.id]||cat.name)+'</span><span class="text-xs opacity-75">('+riskLabels[cat.risk]+')</span></div>';
        });
        html += '</div>';

        // Risk scores bar chart
        html += '<div class="bg-gray-50 rounded-lg p-4"><p class="text-sm font-bold text-gray-600 mb-3">Risico Scores per Categorie</p><div class="space-y-2">';
        const allCatNames = {metabolic_resistance:'Metabole Weerstand',thyroid:'Schildklier',hormonal:'PCOS/Hormonen',cortisol:'Cortisol',insulin:'Insuline',medication:'Medicatie',standard:'Standaard'};
        Object.entries(riskScores).sort((a,b)=>b[1]-a[1]).forEach(([key, score]) => {
          const maxPossible = 10;
          const pct = Math.min((score/maxPossible)*100, 100);
          const barColor = score >= 6 ? 'bg-red-500' : score >= 4 ? 'bg-orange-500' : score >= 3 ? 'bg-yellow-500' : 'bg-green-500';
          html += '<div class="flex items-center gap-3"><span class="text-xs text-gray-600 w-36 text-right">'+(allCatNames[key]||key)+'</span><div class="flex-1 bg-gray-200 rounded-full h-4 relative"><div class="h-4 rounded-full '+barColor+' transition-all" style="width:'+pct+'%"></div></div><span class="text-xs font-bold w-8 text-right">'+score+'</span></div>';
        });
        html += '</div></div></div>';

        // Volledige vragenlijst
        html += '<div class="p-6"><h3 class="font-bold text-lg mb-4"><i class="fas fa-list-ol mr-2 text-green-600"></i>Volledige Antwoorden ('+Object.keys(responses).length+' vragen)</h3><div class="space-y-3">';

        const questionOrder = ["gender","age","duration_trying","weight_loss_success","fatigue_cold_dry","menstrual_regularity","stress_frequency","sleep_quality","medication_use","statin_side_effects","hunger_after_meal","fat_distribution","sugar_cravings","menopause_status","diagnosed_conditions"];

        questionOrder.forEach((qId, idx) => {
          if (responses[qId] === undefined && responses[qId] === null) return;
          const qInfo = questionLabels[qId] || { text: qId, indicator: 'Overig', icon: 'fa-question' };
          const rawAnswer = responses[qId];
          const labels = answerLabels[qId] || {};

          let displayAnswer = '';
          if (Array.isArray(rawAnswer)) {
            displayAnswer = rawAnswer.map(a => labels[a] || a).join(', ');
          } else if (typeof rawAnswer === 'number') {
            displayAnswer = String(rawAnswer);
            if (qId === 'age') displayAnswer += ' jaar';
          } else {
            displayAnswer = labels[rawAnswer] || rawAnswer || '-';
          }

          const severity = getAnswerSeverity(qId, rawAnswer);
          const severityStyles = {
            severe: 'border-l-4 border-red-500 bg-red-50/50',
            moderate: 'border-l-4 border-orange-400 bg-orange-50/30',
            normal: 'border-l-4 border-gray-200'
          };
          const severityDot = {
            severe: '<span class="w-2 h-2 rounded-full bg-red-500 inline-block mr-1"></span>',
            moderate: '<span class="w-2 h-2 rounded-full bg-orange-400 inline-block mr-1"></span>',
            normal: ''
          };

          html += '<div class="rounded-lg p-4 '+severityStyles[severity]+' transition hover:shadow-sm"><div class="flex items-start gap-3"><div class="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0"><span class="text-xs font-bold text-primary-700">'+(idx+1)+'</span></div><div class="flex-1"><div class="flex items-center gap-2 mb-1"><span class="text-xs font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-600"><i class="fas '+qInfo.icon+' mr-1"></i>'+qInfo.indicator+'</span></div><p class="font-medium text-gray-800 mb-1">'+qInfo.text+'</p><p class="text-gray-700 font-semibold">'+severityDot[severity]+displayAnswer+'</p></div></div></div>';
        });

        html += '</div></div>';

        // Triggers per categorie
        if (categories.length) {
          html += '<div class="p-6 border-t"><h3 class="font-bold text-lg mb-4"><i class="fas fa-exclamation-triangle mr-2 text-yellow-600"></i>Gevonden Triggers per Categorie</h3><div class="grid grid-cols-1 md:grid-cols-2 gap-4">';
          categories.forEach(cat => {
            html += '<div class="border-l-4 rounded-lg p-4 '+riskColors[cat.risk]+'"><p class="font-bold '+riskTextColors[cat.risk]+' mb-2"><i class="fas '+cat.icon+' mr-2"></i>'+(categoryNames[cat.id]||cat.name)+' - '+riskLabels[cat.risk]+'</p><ul class="text-sm space-y-1 ml-4 list-disc '+riskTextColors[cat.risk]+'">'+cat.triggers.map(t=>'<li>'+t+'</li>').join('')+'</ul></div>';
          });
          html += '</div></div>';
        }

        // Action buttons
        html += '<div class="p-6 border-t bg-gray-50 rounded-b-xl flex flex-wrap gap-3"><a href="/admin/patient/'+patientId+'" class="bg-primary-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-primary-700"><i class="fas fa-user mr-2"></i>Patiëntprofiel</a><a href="/admin/results/'+patientId+'/'+assessmentId+'" class="bg-green-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-green-700"><i class="fas fa-chart-bar mr-2"></i>Resultaten & Lab</a><button onclick="window.print()" class="border border-gray-300 px-6 py-3 rounded-lg font-medium hover:bg-white"><i class="fas fa-print mr-2"></i>Print Assessment</button></div>';

        html += '</div>';
        document.getElementById('assessment-detail').innerHTML = html;
      } catch(e) {
        document.getElementById('assessment-detail').innerHTML = '<p class="text-red-500 text-center py-12">Fout bij laden: '+e.message+'</p>';
      }
    }

    async function markReviewed() {
      if (!confirm('Weet je zeker dat je de beoordeling wilt vrijgeven? De patiënt kan dan de resultaten bekijken.')) return;
      const btn = document.getElementById('review-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Bezig...';
      try {
        const res = await fetch('/api/assessments/'+assessmentId+'/review', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ review_status: 'reviewed' })
        });
        if (res.ok) { location.reload(); }
        else { const d = await res.json(); alert('Fout: '+(d.error||'Onbekend')); btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle mr-1"></i>Beoordeling vrijgeven'; }
      } catch(e) { alert('Verbindingsfout'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle mr-1"></i>Beoordeling vrijgeven'; }
    }

    async function markFollowup() {
      const notes = prompt('Optioneel: notitie voor vervolgactie');
      try {
        const res = await fetch('/api/assessments/'+assessmentId+'/review', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ review_status: 'needs_followup', reviewer_notes: notes || '' })
        });
        if (res.ok) { location.reload(); }
        else { const d = await res.json(); alert('Fout: '+(d.error||'Onbekend')); }
      } catch(e) { alert('Verbindingsfout'); }
    }

    async function undoReview() {
      if (!confirm('Wilt u de beoordeling intrekken? De patiënt kan dan de resultaten niet meer zien.')) return;
      try {
        const res = await fetch('/api/assessments/'+assessmentId+'/review', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ review_status: 'pending_review' })
        });
        if (res.ok) { location.reload(); }
      } catch(e) { alert('Verbindingsfout'); }
    }

    loadAssessmentDetail();
  </script>
</body></html>`)
})

// PROTOCOL DETAIL PAGE
app.get('/admin/protocol/:patientId/:protocolId', (c) => {
  const patientId = c.req.param('patientId')
  const protocolId = c.req.param('protocolId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-4xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/admin/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
    <div id="protocol-container"><p class="text-center py-12 text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>Laden...</p></div>
  </main>
  <script>
    const patientId = '${patientId}';
    const protocolId = '${protocolId}';

    async function loadProtocol() {
      try {
        const [patientRes, protocolsRes] = await Promise.all([
          fetch('/api/patients/'+patientId),
          fetch('/api/protocols/'+patientId)
        ]);
        const patient = await patientRes.json();
        const protocols = await protocolsRes.json();
        const proto = protocols.find(p=>p.id===protocolId);
        if(!proto){document.getElementById('protocol-container').innerHTML='<p class="text-red-500">Protocol niet gevonden</p>';return;}

        const supps = proto.supplements||[];
        const nutr = proto.nutrition||{};
        const life = proto.lifestyle||{};
        const medAdv = proto.medication_advice||[];
        const warnings = Array.isArray(proto.warnings) ? proto.warnings : [];

        let html = '<div class="bg-white rounded-xl shadow"><div class="bg-gradient-to-r from-purple-600 to-pink-600 text-white p-6 rounded-t-xl"><h2 class="text-2xl font-bold"><i class="fas fa-file-medical mr-2"></i>Protocol: '+patient.first_name+' '+patient.last_name+'</h2><p class="opacity-90 mt-1">Type: '+proto.protocol_type+' | Aangemaakt: '+new Date(proto.created_at).toLocaleDateString('nl-NL')+'</p></div><div class="p-6">';

        // Waarschuwingen voor conflicterende adviezen
        if(warnings.length) {
          html += '<div class="mb-6 space-y-3">';
          warnings.forEach(w => {
            html += '<div class="bg-orange-50 border-l-4 border-orange-500 p-4 rounded"><p class="font-bold text-orange-800 mb-1"><i class="fas fa-exclamation-triangle mr-2"></i>Let op: conflicterend advies</p><p class="text-sm text-orange-700">'+w+'</p></div>';
          });
          html += '</div>';
        }

        // Supplements
        html += '<h3 class="font-bold text-lg mb-4"><i class="fas fa-pills mr-2 text-purple-600"></i>1. Supplementen Protocol</h3><div class="overflow-x-auto mb-6"><table class="w-full text-sm"><thead><tr class="bg-gray-50"><th class="p-3 text-left">Supplement</th><th class="p-3 text-left">Dosering</th><th class="p-3 text-left">Timing</th><th class="p-3 text-left">Reden</th><th class="p-3 text-left">Duur</th></tr></thead><tbody>';
        supps.forEach(s=>{
          html += '<tr class="border-b hover:bg-gray-50"><td class="p-3 font-semibold">'+s.name+'</td><td class="p-3">'+s.dosage+'</td><td class="p-3">'+s.timing+'</td><td class="p-3 text-gray-600">'+s.reason+'</td><td class="p-3 text-gray-500">'+s.duration+'</td></tr>';
        });
        html += '</tbody></table></div>';

        // Nutrition
        html += '<h3 class="font-bold text-lg mb-4"><i class="fas fa-utensils mr-2 text-green-600"></i>2. Voedingsrichtlijnen</h3><div class="bg-green-50 p-4 rounded-lg mb-6"><div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4"><div class="bg-white p-3 rounded shadow-sm"><p class="text-xs text-gray-500">Koolhydraten</p><p class="font-bold text-green-700">'+(nutr.carbs||'-')+'</p></div><div class="bg-white p-3 rounded shadow-sm"><p class="text-xs text-gray-500">Eiwitten</p><p class="font-bold text-green-700">'+(nutr.protein||'-')+'</p></div><div class="bg-white p-3 rounded shadow-sm"><p class="text-xs text-gray-500">Vetten</p><p class="font-bold text-green-700">'+(nutr.fats||'-')+'</p></div><div class="bg-white p-3 rounded shadow-sm"><p class="text-xs text-gray-500">Vezels</p><p class="font-bold text-green-700">'+(nutr.fiber||'-')+'</p></div></div>';
        if(nutr.avoid?.length) html += '<p class="font-bold text-red-700 mb-1">Te vermijden:</p><ul class="text-sm text-red-600 ml-4 mb-3 list-disc">'+nutr.avoid.map(a=>'<li>'+a+'</li>').join('')+'</ul>';
        if(nutr.recommend?.length) html += '<p class="font-bold text-green-700 mb-1">Aanbevolen:</p><ul class="text-sm text-green-600 ml-4 list-disc">'+nutr.recommend.map(r=>'<li>'+r+'</li>').join('')+'</ul>';
        html += '</div>';

        // Lifestyle
        html += '<h3 class="font-bold text-lg mb-4"><i class="fas fa-heart mr-2 text-red-500"></i>3. Leefstijl Interventies</h3><div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">';
        if(life.exercise?.length) html += '<div class="bg-blue-50 p-4 rounded-lg"><p class="font-bold text-blue-800 mb-2"><i class="fas fa-dumbbell mr-1"></i>Beweging</p><ul class="text-sm text-blue-700 space-y-1">'+life.exercise.map(e=>'<li>• '+e+'</li>').join('')+'</ul></div>';
        if(life.sleep?.length) html += '<div class="bg-purple-50 p-4 rounded-lg"><p class="font-bold text-purple-800 mb-2"><i class="fas fa-moon mr-1"></i>Slaap</p><ul class="text-sm text-purple-700 space-y-1">'+life.sleep.map(s=>'<li>• '+s+'</li>').join('')+'</ul></div>';
        if(life.stress?.length) html += '<div class="bg-orange-50 p-4 rounded-lg"><p class="font-bold text-orange-800 mb-2"><i class="fas fa-spa mr-1"></i>Stress</p><ul class="text-sm text-orange-700 space-y-1">'+life.stress.map(s=>'<li>• '+s+'</li>').join('')+'</ul></div>';
        html += '</div>';

        // Medication advice
        if(medAdv.length) {
          html += '<h3 class="font-bold text-lg mb-4"><i class="fas fa-stethoscope mr-2 text-yellow-600"></i>4. Medicatie Aanbeveling (voor huisarts)</h3><div class="space-y-3 mb-6">';
          medAdv.forEach(m=>{
            html += '<div class="bg-yellow-50 border-l-4 border-yellow-500 p-4 rounded"><p class="font-bold text-yellow-800">'+m.recommendation+'</p><p class="text-sm text-yellow-700 mt-1"><strong>Dosering:</strong> '+m.dosage+'</p><p class="text-sm text-yellow-700"><strong>Monitoring:</strong> '+m.monitoring+'</p></div>';
          });
          html += '</div>';
        }

        // Action buttons
        html += '<div class="flex gap-3 mt-6 border-t pt-6"><button onclick="window.print()" class="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-blue-700"><i class="fas fa-print mr-2"></i>Print Protocol</button><a href="/admin/patient/'+patientId+'" class="border border-gray-300 px-6 py-3 rounded-lg font-medium hover:bg-gray-50"><i class="fas fa-arrow-left mr-2"></i>Terug naar patiënt</a></div>';

        html += '</div></div>';
        document.getElementById('protocol-container').innerHTML = html;
      } catch(e) {
        document.getElementById('protocol-container').innerHTML='<p class="text-red-500 text-center py-12">Fout: '+e.message+'</p>';
      }
    }
    loadProtocol();
  </script>
</body></html>`)
})

// =====================================================
// ADMIN KENNISBANK - Naslagwerk voor therapeut
// =====================================================
app.get('/admin/kennisbank', (c) => {
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-6xl mx-auto px-4 py-8">
    <div class="mb-8">
      <h2 class="text-2xl font-bold text-gray-800"><i class="fas fa-book-medical mr-2 text-primary-600"></i>Kennisbank</h2>
      <p class="text-gray-500">Naslagwerk voor de therapeut — Orthomoleculair protocol bij overgewicht</p>
    </div>

    <!-- NAVIGATIE TABS -->
    <div class="flex flex-wrap gap-2 mb-8 sticky top-0 bg-gray-50 py-3 z-10 border-b">
      <button onclick="showSection('intake')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-primary-600 text-white" data-tab="intake"><i class="fas fa-clipboard-list mr-1"></i>Intakevragen</button>
      <button onclick="showSection('beslisboom')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" data-tab="beslisboom"><i class="fas fa-project-diagram mr-1"></i>Beslisboom</button>
      <button onclick="showSection('classificatie')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" data-tab="classificatie"><i class="fas fa-tags mr-1"></i>Classificatie</button>
      <button onclick="showSection('labtesten')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" data-tab="labtesten"><i class="fas fa-flask mr-1"></i>Labtesten</button>
      <button onclick="showSection('supplementen')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" data-tab="supplementen"><i class="fas fa-capsules mr-1"></i>Supplementen</button>
      <button onclick="showSection('medicatie')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" data-tab="medicatie"><i class="fas fa-pills mr-1"></i>Medicatie</button>
      <button onclick="showSection('aandoeningen')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" data-tab="aandoeningen"><i class="fas fa-stethoscope mr-1"></i>Aandoeningen</button>
      <button onclick="showSection('communicatie')" class="kb-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" data-tab="communicatie"><i class="fas fa-comments mr-1"></i>Communicatie</button>
    </div>

    <!-- ===================== SECTIE 1: INTAKEVRAGEN ===================== -->
    <div id="sec-intake" class="kb-section">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-clipboard-list mr-2"></i>Standaard Intakevragenlijst</h3>
        <p class="text-gray-600 mb-6">Gebaseerd op de <strong>Check Oorzaken Overgewicht</strong> (Leefstijlcoalitie). Online vooraf invullen door patiënt.</p>
        
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="bg-gray-50"><th class="p-3 text-left font-bold">Categorie</th><th class="p-3 text-left font-bold">Sleutelvragen</th><th class="p-3 text-left font-bold">Wat brengt dit in kaart?</th></tr></thead>
            <tbody>
              <tr class="border-t"><td class="p-3 font-semibold text-primary-700">Medische voorgeschiedenis</td><td class="p-3">Welke aandoeningen heeft u? Medicatie? Familieanamnese obesitas/diabetes/schildklier?</td><td class="p-3 text-gray-500">Onderliggende pathologie, medicatie-interacties</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold text-primary-700">Leefstijlfactoren</td><td class="p-3">Hoe is uw eetpatroon? Wie kookt? Eetmomenten? Maaltijdfrequentie?</td><td class="p-3 text-gray-500">Gedragsdeterminanten, sociale omgeving</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold text-primary-700">Bewegingspatroon</td><td class="p-3">Hoeveel beweegt u dagelijks? Welke barrières ervaart u?</td><td class="p-3 text-gray-500">Energiebalans, fysieke mogelijkheden</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold text-primary-700">Psychosociale factoren</td><td class="p-3">Ervaart u stress? Hoe slaapt u? Sociale steun?</td><td class="p-3 text-gray-500">Cortisol, emotioneel eten, adherence</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold text-primary-700">Slaapkwaliteit</td><td class="p-3">Hoeveel uur slaapt u? Slaapapneu-vermoeden? Snurken?</td><td class="p-3 text-gray-500">Leptine/ghreline disbalans</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold text-primary-700">Werk & economie</td><td class="p-3">Werkstatus, financiële situatie, voedselomgeving</td><td class="p-3 text-gray-500">Sociaaleconomische determinanten</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-amber-700"><i class="fas fa-search-plus mr-2"></i>Aanvullende Orthomoleculaire Intakevragen</h3>
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="border rounded-xl p-5">
            <h4 class="font-bold text-gray-800 mb-3"><i class="fas fa-utensils mr-1 text-amber-500"></i>Voeding & Vertering</h4>
            <ul class="space-y-2 text-sm text-gray-600">
              <li>• Welke voedingsmiddelen geeft u de voorkeur? (kwaliteit eiwitten, vetten, vezels)</li>
              <li>• Hoe is uw stoelgang? (indicatie absorptie/vertering)</li>
              <li>• Alcohol, koffie, zoetstoffen? (invloed hormonen/mitochondriën)</li>
              <li>• Specifieke cravings? <span class="text-amber-600 font-medium">Suiker=insuline, Zout=bijnieren, Chocola=magnesium</span></li>
            </ul>
          </div>
          <div class="border rounded-xl p-5">
            <h4 class="font-bold text-gray-800 mb-3"><i class="fas fa-heartbeat mr-1 text-red-500"></i>Symptomen Screening</h4>
            <ul class="space-y-2 text-sm text-gray-600">
              <li>• <strong>Vermoeidheid + koud + droge huid</strong> → Schildklierdisfunctie</li>
              <li>• <strong>Buikvet + suikerhonger + snel honger</strong> → Insulineresistentie</li>
              <li>• <strong>Stress + wakker liggen + middagdip 15:00</strong> → Cortisol disbalans</li>
              <li>• <strong>Spierpijn + statinegebruik</strong> → CoQ10-deficiëntie</li>
              <li>• <strong>Slaapapneu-vermoeden</strong> → Leptine/ghreline disbalans</li>
            </ul>
          </div>
        </div>
      </div>

      <div class="bg-blue-50 border-2 border-blue-200 rounded-2xl p-6">
        <h4 class="font-bold text-blue-800 mb-2"><i class="fas fa-ruler mr-2"></i>Lichamelijk Onderzoek (altijd bij intake)</h4>
        <div class="flex flex-wrap gap-4 text-sm">
          <span class="bg-white px-3 py-1 rounded-lg border">BMI berekenen</span>
          <span class="bg-white px-3 py-1 rounded-lg border">Buikomvang meten</span>
          <span class="bg-white px-3 py-1 rounded-lg border">Bloeddruk</span>
          <span class="bg-white px-3 py-1 rounded-lg border">Vetpercentage (bio-impedantie)</span>
          <span class="bg-white px-3 py-1 rounded-lg border">Spiermassa</span>
        </div>
      </div>
    </div>

    <!-- ===================== SECTIE 2: BESLISBOOM ===================== -->
    <div id="sec-beslisboom" class="kb-section hidden">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-project-diagram mr-2"></i>Beslisboom: "Waarom valt deze patiënt niet af?"</h3>
        
        <div class="bg-gray-900 text-green-400 rounded-xl p-6 font-mono text-sm overflow-x-auto whitespace-pre leading-relaxed">PATIËNT STAGNEERT ONDANKS INSPANNINGEN
           │
           ▼
    Is het een VROUW met specifieke kenmerken?
    (PCOS, schildklier, menopauze)
           │
    ┌──────┴──────┐
    JA            NEE
    │             │
    ▼             ▼
Screen op:    Is er MEDICATIEgebruik?
• Schildklier  (statines, antipsychotica,
• PCOS         insuline, prednison,
• Oestrogeen   bètablokkers, etc.)
               │
        ┌──────┴──────┐
        JA            NEE
        │             │
        ▼             ▼
   Pas protocol    Is er Slaap/Stress-probleem?
   aan (medicatie)     │
               ┌──────┴──────┐
               JA            NEE
               │             │
               ▼             ▼
          Focus op:       Vermoeden metabole
          • Cortisol      weerstand / mitochondriële
          • Slaaphygiëne  disfunctie?
          • Stressmgmt        │
                         ┌────┴────┐
                         JA      NEE
                         │        │
                         ▼        ▼
                    Uitgebreid  Standaard
                    lab-pakket  protocol</div>
      </div>

      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-red-700"><i class="fas fa-flag mr-2"></i>Rode Vlaggen voor Metabole Weerstand</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="border-l-4 border-red-500 pl-4 py-2">
            <p class="font-semibold text-gray-800">Afvallen lukt niet ondanks strikte calorierestrictie</p>
            <p class="text-sm text-gray-500">Onderliggende blokkade waarschijnlijk</p>
          </div>
          <div class="border-l-4 border-red-500 pl-4 py-2">
            <p class="font-semibold text-gray-800">Gewichtsplateau ondanks inspanningen</p>
            <p class="text-sm text-gray-500">Metabole adaptatie of hormonale factor</p>
          </div>
          <div class="border-l-4 border-red-500 pl-4 py-2">
            <p class="font-semibold text-gray-800">PCOS-kenmerken</p>
            <p class="text-sm text-gray-500">Onregelmatige menstruatie, acne, hirsutisme</p>
          </div>
          <div class="border-l-4 border-red-500 pl-4 py-2">
            <p class="font-semibold text-gray-800">Hashimoto/schildklier in voorgeschiedenis</p>
            <p class="text-sm text-gray-500">Auto-immuun component</p>
          </div>
          <div class="border-l-4 border-red-500 pl-4 py-2">
            <p class="font-semibold text-gray-800">Menopauze-gerelateerd gewichtsplateau</p>
            <p class="text-sm text-gray-500">Oestrogeendaling → verandering vetdistributie</p>
          </div>
          <div class="border-l-4 border-red-500 pl-4 py-2">
            <p class="font-semibold text-gray-800">Onverklaarde vermoeidheid</p>
            <p class="text-sm text-gray-500">Niet verklaard door slaapgebrek</p>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-lg p-8">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-list-ol mr-2"></i>Intake Workflow (Stappenplan)</h3>
        <div class="space-y-4">
          <div class="flex gap-4 items-start"><div class="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0"><span class="font-bold text-primary-700">1</span></div><div><p class="font-bold text-gray-800">Voorbereiding</p><p class="text-sm text-gray-600">Patiënt vult online vragenlijst in. Bekijk resultaten vooraf. Noteer rode vlaggen.</p></div></div>
          <div class="flex gap-4 items-start"><div class="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0"><span class="font-bold text-primary-700">2</span></div><div><p class="font-bold text-gray-800">Intakegesprek (45-60 min)</p><p class="text-sm text-gray-600">Toestemming & vertrouwen. Besprek resultaten. Orthomoleculaire vragen. Anamnese medicatie. Lichamelijk onderzoek: BMI, buikomvang, bloeddruk.</p></div></div>
          <div class="flex gap-4 items-start"><div class="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0"><span class="font-bold text-primary-700">3</span></div><div><p class="font-bold text-gray-800">Screening & Lab</p><p class="text-sm text-gray-600">Basis: TSH, glucose, HbA1c, lipiden, lever, nier. Uitgebreid bij vermoeden metabole weerstand.</p></div></div>
          <div class="flex gap-4 items-start"><div class="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0"><span class="font-bold text-primary-700">4</span></div><div><p class="font-bold text-gray-800">Analyse & Plan</p><p class="text-sm text-gray-600">Identificeer dominante factor(en). Stel supplementprotocol op. Formuleer gepersonaliseerd voedings- en bewegingsadvies. Plan vervolgconsult.</p></div></div>
        </div>
      </div>
    </div>

    <!-- ===================== SECTIE 3: CLASSIFICATIE ===================== -->
    <div id="sec-classificatie" class="kb-section hidden">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-tags mr-2"></i>Dominante Mechanismen bij Metabole Weerstand</h3>
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="border-2 border-red-200 rounded-xl p-5 bg-red-50/30">
            <h4 class="font-bold text-red-700 mb-2"><i class="fas fa-candy-cane mr-1"></i>Insuline-gedreven</h4>
            <p class="text-sm text-gray-700 mb-2"><strong>Kenmerken:</strong> Buikvet, suikerhonger, PCOS</p>
            <p class="text-sm text-gray-700"><strong>Primaire interventie:</strong> Koolhydraatrestrictie, metformine-overleg, myo-inositol</p>
          </div>
          <div class="border-2 border-indigo-200 rounded-xl p-5 bg-indigo-50/30">
            <h4 class="font-bold text-indigo-700 mb-2"><i class="fas fa-moon mr-1"></i>Schildklier-gedreven</h4>
            <p class="text-sm text-gray-700 mb-2"><strong>Kenmerken:</strong> Koud, moe, droge huid, constipatie</p>
            <p class="text-sm text-gray-700"><strong>Primaire interventie:</strong> Schildklieroptimalisatie (medicatie, selenium, zink)</p>
          </div>
          <div class="border-2 border-orange-200 rounded-xl p-5 bg-orange-50/30">
            <h4 class="font-bold text-orange-700 mb-2"><i class="fas fa-brain mr-1"></i>Cortisol-gedreven</h4>
            <p class="text-sm text-gray-700 mb-2"><strong>Kenmerken:</strong> Middagdip, stressbuik, slaapstoornissen</p>
            <p class="text-sm text-gray-700"><strong>Primaire interventie:</strong> Stressmanagement, fosfatidylserine, adaptogenen</p>
          </div>
          <div class="border-2 border-pink-200 rounded-xl p-5 bg-pink-50/30">
            <h4 class="font-bold text-pink-700 mb-2"><i class="fas fa-venus mr-1"></i>PCOS / Hormonen</h4>
            <p class="text-sm text-gray-700 mb-2"><strong>Kenmerken:</strong> Onregelmatige cyclus, acne, hirsutisme</p>
            <p class="text-sm text-gray-700"><strong>Primaire interventie:</strong> Insuline behandelen + inositol + anti-androgeen</p>
          </div>
          <div class="border-2 border-blue-200 rounded-xl p-5 bg-blue-50/30">
            <h4 class="font-bold text-blue-700 mb-2"><i class="fas fa-pills mr-1"></i>Medicatie-gerelateerd</h4>
            <p class="text-sm text-gray-700 mb-2"><strong>Kenmerken:</strong> Statines, SSRI, bètablokkers, prednison</p>
            <p class="text-sm text-gray-700"><strong>Primaire interventie:</strong> Nutriëntdepletie compenseren, overleg voorschrijver</p>
          </div>
          <div class="border-2 border-gray-200 rounded-xl p-5 bg-gray-50/30">
            <h4 class="font-bold text-gray-700 mb-2"><i class="fas fa-layer-group mr-1"></i>Multifactorieel</h4>
            <p class="text-sm text-gray-700 mb-2"><strong>Kenmerken:</strong> Meerdere overlappende signalen</p>
            <p class="text-sm text-gray-700"><strong>Primaire interventie:</strong> Gepersonaliseerd protocol, integrale aanpak</p>
          </div>
        </div>
      </div>

      <div class="bg-amber-50 border-2 border-amber-200 rounded-2xl p-6">
        <h4 class="font-bold text-amber-800 mb-3"><i class="fas fa-exclamation-triangle mr-2"></i>Belangrijke Combinaties (Vicieuze Cirkels)</h4>
        <ul class="space-y-2 text-sm">
          <li class="flex items-start gap-2"><span class="text-red-500 mt-0.5">●</span><span><strong>Metabole weerstand + Insuline:</strong> Sterk verhoogd risico metabool syndroom</span></li>
          <li class="flex items-start gap-2"><span class="text-red-500 mt-0.5">●</span><span><strong>Schildklier + Cortisol:</strong> Stress remt T4→T3 conversie (vicieuze cirkel)</span></li>
          <li class="flex items-start gap-2"><span class="text-red-500 mt-0.5">●</span><span><strong>PCOS + Insuline:</strong> Insuline drijft androgeenproductie → behandel insuline EERST</span></li>
          <li class="flex items-start gap-2"><span class="text-orange-500 mt-0.5">●</span><span><strong>Slechte slaap + Dagelijkse stress:</strong> Prioriteer stressreductie vóór andere interventies</span></li>
          <li class="flex items-start gap-2"><span class="text-orange-500 mt-0.5">●</span><span><strong>&gt;1 jaar falen + geen resultaat:</strong> Onderliggende metabole blokkade waarschijnlijk</span></li>
        </ul>
      </div>
    </div>

    <!-- ===================== SECTIE 4: LABTESTEN ===================== -->
    <div id="sec-labtesten" class="kb-section hidden">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-flask mr-2"></i>Basis Bloedpakket (altijd aanvragen)</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="bg-gray-50"><th class="p-3 text-left font-bold">Test</th><th class="p-3 text-left font-bold">Doelwaarden</th><th class="p-3 text-left font-bold">Waarom?</th></tr></thead>
            <tbody>
              <tr class="border-t"><td class="p-3 font-semibold">TSH + fT4 + fT3</td><td class="p-3"><code>TSH 0,4-2,5 mU/L</code></td><td class="p-3 text-gray-500">Schildklierfunctie — essentieel bij gewichtsproblematiek</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Glucose (nuchter) + HbA1c</td><td class="p-3"><code>HbA1c &lt; 5,7%</code></td><td class="p-3 text-gray-500">Glucosemetabolisme, diabetes screening</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">Insuline (nuchter) + HOMA-IR</td><td class="p-3"><code>Insuline &lt; 6 mU/L, HOMA &lt; 2,0</code></td><td class="p-3 text-gray-500">Insulineresistentie — vaak verhoogd vóór glucose stijgt</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Lipidenprofiel (Chol, HDL, LDL, TG)</td><td class="p-3"><code>TG/HDL ratio &lt; 2</code></td><td class="p-3 text-gray-500">Cardiovasculair risico, metabool syndroom</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">Leverfunctie (ALAT, ASAT, GGT)</td><td class="p-3"><code>Normaal bereik</code></td><td class="p-3 text-gray-500">Uitsluiten leververvetting (NAFLD)</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Nierfunctie (Creatinine + eGFR)</td><td class="p-3"><code>Normaal bereik</code></td><td class="p-3 text-gray-500">Essentieel bij metabool syndroom</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">Bloedbeeld (Hb, MCV)</td><td class="p-3"><code>Normaal bereik</code></td><td class="p-3 text-gray-500">Anemie screening (ijzer vs B12/folaat)</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Vitamine D (25-OH)</td><td class="p-3"><code>75-125 nmol/L</code></td><td class="p-3 text-gray-500">Tekort versterkt insulineresistentie</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">Ferritine</td><td class="p-3"><code>30-100 µg/L</code></td><td class="p-3 text-gray-500">Laag ferritine = vermoeidheid, belemmert afvallen</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Cortisol (ochtend) + DHEA-S</td><td class="p-3"><code>250-700 nmol/L</code></td><td class="p-3 text-gray-500">Bijnierfunctie, cortisol/DHEA-S ratio</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-amber-700"><i class="fas fa-plus-circle mr-2"></i>Uitgebreid Pakket (bij vermoeden metabole weerstand)</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="bg-amber-50"><th class="p-3 text-left font-bold">Test</th><th class="p-3 text-left font-bold">Indicatie</th><th class="p-3 text-left font-bold">Specifieke situatie</th></tr></thead>
            <tbody>
              <tr class="border-t"><td class="p-3 font-semibold">rT3 (reverse T3)</td><td class="p-3">T4-conversieprobleem</td><td class="p-3 text-gray-500">Vermoeidheid, schildkliermedicatie werkt niet goed</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">TPO-antistoffen + Anti-Tg</td><td class="p-3">Hashimoto screening</td><td class="p-3 text-gray-500">Auto-immuun schildklierontsteking</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">Leptine</td><td class="p-3">Leptineresistentie</td><td class="p-3 text-gray-500">Brein registreert geen verzadiging ondanks vetreserves</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Testosteron (vrij) + SHBG + LH/FSH</td><td class="p-3">PCOS / androgeen status</td><td class="p-3 text-gray-500">Hirsutisme, acne, onregelmatige cyclus</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">Progesteron (dag 21)</td><td class="p-3">Ovulatie bevestiging</td><td class="p-3 text-gray-500">Anovulatie is hoofdoorzaak gewichtstoename bij PCOS</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">hs-CRP</td><td class="p-3">Laaggradige ontsteking</td><td class="p-3 text-gray-500">&gt;1,0 mg/L = verhoogd risico</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">Homocysteïne</td><td class="p-3">Methyleringsdefect</td><td class="p-3 text-gray-500">Verhoogd = B12/folaat tekort + cardiovasculair risico</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">IGF-1</td><td class="p-3">Groeihormoon</td><td class="p-3 text-gray-500">Buikvet + verlaagde spiermassa</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold">NMR-lipidenprofiel</td><td class="p-3">Lipiden subfracties</td><td class="p-3 text-gray-500">Cardiovasculair risico bij overgewicht</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-lg p-8">
        <h3 class="text-xl font-bold mb-4 text-emerald-700"><i class="fas fa-microscope mr-2"></i>Ontlastingsonderzoek</h3>
        <p class="text-gray-600 mb-4">Bij darmklachten / metabole weerstand / auto-immuuncomponent</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="border rounded-xl p-4"><p class="font-semibold">Calprotectine</p><p class="text-sm text-gray-500">Darmontsteking marker. &gt;50 = milde ontsteking, &gt;200 = verwijs MDL</p></div>
          <div class="border rounded-xl p-4"><p class="font-semibold">Zonuline</p><p class="text-sm text-gray-500">Leaky gut marker. Verhoogd = verhoogde darmpermeabiliteit</p></div>
          <div class="border rounded-xl p-4"><p class="font-semibold">Pancreas Elastase-1</p><p class="text-sm text-gray-500">Pancreasfunctie. &lt;200 = exocriene insufficiëntie</p></div>
          <div class="border rounded-xl p-4"><p class="font-semibold">sIgA</p><p class="text-sm text-gray-500">Darmimmuunfunctie. Laag = verminderde mucosale afweer</p></div>
          <div class="border rounded-xl p-4"><p class="font-semibold">SCFA (korte-keten vetzuren)</p><p class="text-sm text-gray-500">Microbioom-marker. Laag = dysbiose, verminderde vetverbranding</p></div>
          <div class="border rounded-xl p-4"><p class="font-semibold">Beta-glucuronidase</p><p class="text-sm text-gray-500">Verhoogd = oestrogeenrecirculatie → oestrogeendominantie</p></div>
        </div>
      </div>
    </div>

    <!-- ===================== SECTIE 5: SUPPLEMENTEN ===================== -->
    <div id="sec-supplementen" class="kb-section hidden">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-capsules mr-2"></i>Supplementprotocollen per Categorie</h3>
        
        <div class="space-y-6">
          <div class="border-2 border-indigo-200 rounded-xl overflow-hidden">
            <div class="bg-indigo-50 p-4"><h4 class="font-bold text-indigo-700"><i class="fas fa-moon mr-1"></i>Schildklier-gedreven</h4></div>
            <div class="p-4 text-sm">
              <table class="w-full"><tbody>
                <tr class="border-b"><td class="py-2 font-semibold">Selenium (L-selenomethionine)</td><td class="py-2">200 mcg/dag</td><td class="py-2 text-gray-500">T4→T3 conversie, TPO verlaging</td><td class="py-2">6 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Zink bisglycinaat</td><td class="py-2">25 mg/dag</td><td class="py-2 text-gray-500">T3-receptor binding</td><td class="py-2">3 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">L-carnitine</td><td class="py-2">1000-2000 mg/dag</td><td class="py-2 text-gray-500">Ondersteunt T3-transport</td><td class="py-2">3 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Vitamine D3</td><td class="py-2">4000 IE/dag</td><td class="py-2 text-gray-500">Immuunmodulatie bij Hashimoto</td><td class="py-2">3 mnd, retest</td></tr>
                <tr><td class="py-2 font-semibold">Magnesium citraat</td><td class="py-2">400 mg/dag</td><td class="py-2 text-gray-500">Conversie T4→T3</td><td class="py-2">Doorlopend</td></tr>
              </tbody></table>
            </div>
          </div>

          <div class="border-2 border-red-200 rounded-xl overflow-hidden">
            <div class="bg-red-50 p-4"><h4 class="font-bold text-red-700"><i class="fas fa-candy-cane mr-1"></i>Insuline-gedreven</h4></div>
            <div class="p-4 text-sm">
              <table class="w-full"><tbody>
                <tr class="border-b"><td class="py-2 font-semibold">Myo-inositol</td><td class="py-2">2x 2000 mg/dag</td><td class="py-2 text-gray-500">Insulinegevoeligheid ↑</td><td class="py-2">6 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Berberine</td><td class="py-2">3x 500 mg/dag</td><td class="py-2 text-gray-500">AMPK activatie, bloedsuiker ↓</td><td class="py-2">3 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Chromium</td><td class="py-2">200-400 mcg/dag</td><td class="py-2 text-gray-500">Bloedsuiker regulatie</td><td class="py-2">3 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Alpha-liponzuur</td><td class="py-2">600 mg/dag</td><td class="py-2 text-gray-500">Antioxidant, insulinegevoeligheid</td><td class="py-2">3 mnd</td></tr>
                <tr><td class="py-2 font-semibold">Omega-3 (EPA+DHA)</td><td class="py-2">2000 mg/dag</td><td class="py-2 text-gray-500">Triglyceriden ↓</td><td class="py-2">Doorlopend</td></tr>
              </tbody></table>
            </div>
          </div>

          <div class="border-2 border-orange-200 rounded-xl overflow-hidden">
            <div class="bg-orange-50 p-4"><h4 class="font-bold text-orange-700"><i class="fas fa-brain mr-1"></i>Cortisol-gedreven</h4></div>
            <div class="p-4 text-sm">
              <table class="w-full"><tbody>
                <tr class="border-b"><td class="py-2 font-semibold">Ashwagandha (KSM-66)</td><td class="py-2">2x 300 mg/dag</td><td class="py-2 text-gray-500">Cortisol verlaging</td><td class="py-2">3 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Fosfatidylserine</td><td class="py-2">300 mg/dag</td><td class="py-2 text-gray-500">Cortisol verlaging 's avonds</td><td class="py-2">2 mnd</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Magnesium citraat</td><td class="py-2">400-600 mg/dag</td><td class="py-2 text-gray-500">Ontspanning & slaap</td><td class="py-2">Doorlopend</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Vitamine C</td><td class="py-2">1000 mg/dag</td><td class="py-2 text-gray-500">Bijnierfunctie</td><td class="py-2">Doorlopend</td></tr>
                <tr><td class="py-2 font-semibold">L-Theanine</td><td class="py-2">200 mg/dag</td><td class="py-2 text-gray-500">Ontspanning zonder slaperigheid</td><td class="py-2">Naar behoefte</td></tr>
              </tbody></table>
            </div>
          </div>

          <div class="border-2 border-blue-200 rounded-xl overflow-hidden">
            <div class="bg-blue-50 p-4"><h4 class="font-bold text-blue-700"><i class="fas fa-pills mr-1"></i>Medicatie-gerelateerd</h4></div>
            <div class="p-4 text-sm">
              <table class="w-full"><tbody>
                <tr class="border-b"><td class="py-2 font-semibold">Ubiquinol (CoQ10)</td><td class="py-2">200-300 mg/dag</td><td class="py-2 text-gray-500">Bij statinegebruik — ESSENTIEEL</td><td class="py-2">Zolang statine</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Vitamine B12 (methylcobalamine)</td><td class="py-2">1000 mcg/dag</td><td class="py-2 text-gray-500">Bij metformine (25-50% risico depletie)</td><td class="py-2">Zolang metformine</td></tr>
                <tr class="border-b"><td class="py-2 font-semibold">Folaat (5-MTHF)</td><td class="py-2">400-800 mcg/dag</td><td class="py-2 text-gray-500">Methylering</td><td class="py-2">Doorlopend</td></tr>
                <tr><td class="py-2 font-semibold">Magnesium citraat</td><td class="py-2">400 mg/dag</td><td class="py-2 text-gray-500">Depletie door PPI, diuretica, metformine</td><td class="py-2">Doorlopend</td></tr>
              </tbody></table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===================== SECTIE 6: MEDICATIE ===================== -->
    <div id="sec-medicatie" class="kb-section hidden">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-pills mr-2"></i>Medicatie-Interacties & Protocollen</h3>
        
        <div class="space-y-6">
          <div class="border-2 border-indigo-200 rounded-xl overflow-hidden">
            <div class="bg-indigo-50 p-4"><h4 class="font-bold text-indigo-700">Schildkliermedicatie (Levothyroxine / LT4)</h4></div>
            <div class="p-4 space-y-3 text-sm">
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Timing:</span><span>Nuchtere maag, 30-60 min voor ontbijt OF 's avonds 2+ uur na laatste maaltijd</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Interacties:</span><span class="text-red-600 font-medium">Calcium, ijzer, magnesium, cholestyramine: APART innemen (minimaal 4 uur)</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Monitoring:</span><span>TSH elke 6-12 weken bij dosiswijziging, daarna halfjaarlijks</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Doelwaarden:</span><span>TSH 0,4-2,5 (niet alleen "binnen range"), fT3 in bovenste kwartiel</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Conversieprobleem:</span><span>Bij aanhoudende klachten ondanks medicatie: check fT3, rT3, ratio fT3/rT3</span></div>
            </div>
          </div>

          <div class="border-2 border-amber-200 rounded-xl overflow-hidden">
            <div class="bg-amber-50 p-4"><h4 class="font-bold text-amber-700">Statines (Cholesterol-verlagend)</h4></div>
            <div class="p-4 space-y-3 text-sm">
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Mechanisme:</span><span>Blokkeren mevalonaatweg → CoQ10-synthese verlaagd</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Symptomen:</span><span>Spierpijn, krachtsverlies, vermoeidheid, gewichtsverlies stagneert</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Suppletie:</span><span class="font-medium text-red-600">Ubiquinol (actieve vorm) 100-300 mg/dag met vetrijke maaltijd</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Timing:</span><span>Apart van statine (bijv. ochtend statine, avond CoQ10)</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Impact gewicht:</span><span>Zonder CoQ10: vermoeidheid → minder bewegen → cirkel is rond</span></div>
            </div>
          </div>

          <div class="border-2 border-emerald-200 rounded-xl overflow-hidden">
            <div class="bg-emerald-50 p-4"><h4 class="font-bold text-emerald-700">Metformine (Bij PCOS / Insulineresistentie)</h4></div>
            <div class="p-4 space-y-3 text-sm">
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Indicatie:</span><span>PCOS, insulineresistentie, prediabetes, gewichtsplateau ondanks dieet</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Opbouw:</span><span class="font-medium">Start 500 mg 1x/dag → langzaam opbouwen naar 1500-2000 mg/dag</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Bijwerkingen:</span><span>GI-klachten (nausea, diarree) → opbouwen essentieel!</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Nutriënten:</span><span class="text-red-600 font-medium">B12 jaarlijks controleren (25-50% risico depletie)</span></div>
              <div class="flex gap-3"><span class="font-semibold text-gray-700 w-32 flex-shrink-0">Combinatie:</span><span>Ideaal met myo-inositol + koolhydraatrestrictie</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===================== SECTIE 7: AANDOENINGEN ===================== -->
    <div id="sec-aandoeningen" class="kb-section hidden">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-stethoscope mr-2"></i>Aandoening-specifieke Protocollen</h3>
        
        <div class="space-y-6">
          <div class="border rounded-xl overflow-hidden">
            <div class="bg-indigo-600 text-white p-4"><h4 class="font-bold">Hashimoto / Hypothyreoïdie — Stappenplan</h4></div>
            <div class="p-5">
              <div class="space-y-3">
                <div class="flex gap-3 items-start"><span class="bg-indigo-100 text-indigo-700 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm">1</span><div><p class="font-semibold">Screening</p><p class="text-sm text-gray-600">TSH, fT4, fT3, TPO bij elke patiënt met gewichtsproblemen + vermoeidheid/kouwelijkheid</p></div></div>
                <div class="flex gap-3 items-start"><span class="bg-indigo-100 text-indigo-700 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm">2</span><div><p class="font-semibold">Medische behandeling</p><p class="text-sm text-gray-600">Levothyroxine instellen (1,6 µg/kg) → huisarts/internist</p></div></div>
                <div class="flex gap-3 items-start"><span class="bg-indigo-100 text-indigo-700 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm">3</span><div><p class="font-semibold">Orthomoleculaire ondersteuning</p><p class="text-sm text-gray-600">Selenium 200mcg, zink 25mg, L-carnitine, vitamine D, magnesium</p></div></div>
                <div class="flex gap-3 items-start"><span class="bg-indigo-100 text-indigo-700 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm">4</span><div><p class="font-semibold">Dieetinterventies</p><p class="text-sm text-gray-600"><span class="text-red-600 font-medium">Glutenvrij proberen bij TPO+</span>, jodiumbewust, eiwitrijk</p></div></div>
                <div class="flex gap-3 items-start"><span class="bg-indigo-100 text-indigo-700 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm">5</span><div><p class="font-semibold">Monitoring</p><p class="text-sm text-gray-600">TSH/fT3 elke 6-12 weken, symptoomtracking. Gewichtsverlies gaat trager → realistische verwachtingen!</p></div></div>
              </div>
              <div class="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm"><i class="fas fa-lightbulb text-amber-600 mr-1"></i><strong>Let op:</strong> Hashimoto is auto-immuun → ontstekingsremmende leefstijl essentieel (omega-3, curcumine, stressmanagement). Eiwitrijk dieet op maat van schildklierfunctie.</div>
            </div>
          </div>

          <div class="border rounded-xl overflow-hidden">
            <div class="bg-pink-600 text-white p-4"><h4 class="font-bold">PCOS — Integraal Protocol</h4></div>
            <div class="p-5">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead><tr class="bg-pink-50"><th class="p-3 text-left font-bold">Domein</th><th class="p-3 text-left font-bold">Interventie</th><th class="p-3 text-left font-bold">Doel</th></tr></thead>
                  <tbody>
                    <tr class="border-t"><td class="p-3 font-semibold">Insuline</td><td class="p-3">Metformine + myo-inositol + koolhydraatmodulatie</td><td class="p-3 text-gray-500">Insulinegevoeligheid ↑, ovulatieherstel</td></tr>
                    <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Androgenen</td><td class="p-3">Spearmuntthee, inositol, evt. anti-androgenen (huisarts)</td><td class="p-3 text-gray-500">Acne ↓, hirsutisme ↓</td></tr>
                    <tr class="border-t"><td class="p-3 font-semibold">Cyclus</td><td class="p-3">Inositol, gewichtsverlies, stressmanagement</td><td class="p-3 text-gray-500">Reguliere menstruatie, vruchtbaarheid</td></tr>
                    <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Gewicht</td><td class="p-3">Eiwitrijk, vezels, krachttraining, HIIT</td><td class="p-3 text-gray-500">Lichaamssamenstelling, metabolisme</td></tr>
                    <tr class="border-t"><td class="p-3 font-semibold">Suppletie</td><td class="p-3">Inositol 2000-4000mg, omega-3, vit D, chromium, zink</td><td class="p-3 text-gray-500">Multiple mechanismen</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="border rounded-xl overflow-hidden">
            <div class="bg-gray-600 text-white p-4"><h4 class="font-bold">Overige Aandoeningen — Snelreferentie</h4></div>
            <div class="p-5">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead><tr class="bg-gray-50"><th class="p-3 text-left font-bold">Aandoening</th><th class="p-3 text-left font-bold">Impact op gewichtsverlies</th><th class="p-3 text-left font-bold">Aanpak</th></tr></thead>
                  <tbody>
                    <tr class="border-t"><td class="p-3 font-semibold">Cushing</td><td class="p-3">Cortisol-gedreven buikvet</td><td class="p-3 text-gray-500">Verwijzen endocrinoloog</td></tr>
                    <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Slaapapneu</td><td class="p-3">Leptineresistentie door slaapfragmentatie</td><td class="p-3 text-gray-500">Verwijzen polisomnografie, CPAP</td></tr>
                    <tr class="border-t"><td class="p-3 font-semibold">Depressie / SSRI</td><td class="p-3">Gewichtstoename als bijwerking</td><td class="p-3 text-gray-500">Samenwerking psychiater</td></tr>
                    <tr class="border-t bg-gray-50"><td class="p-3 font-semibold">Hypopituitarism</td><td class="p-3">GH-deficiëntie → minder spiermassa</td><td class="p-3 text-gray-500">Verwijzen endocrinoloog</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===================== SECTIE 8: COMMUNICATIE ===================== -->
    <div id="sec-communicatie" class="kb-section hidden">
      <div class="bg-white rounded-2xl shadow-lg p-8 mb-6">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-comments mr-2"></i>Patiëntcommunicatie</h3>
        
        <div class="space-y-6">
          <div class="border-2 border-emerald-200 rounded-xl p-6">
            <h4 class="font-bold text-emerald-700 mb-3"><i class="fas fa-quote-left mr-1"></i>"Het Plateau Gesprek"</h4>
            <p class="text-gray-600 mb-4">Wanneer patiënten vastlopen — de juiste boodschap:</p>
            <blockquote class="bg-emerald-50 border-l-4 border-emerald-500 p-4 rounded-r-xl italic text-gray-700">
              "We hebben uw situatie geanalyseerd en zien dat uw lichaam op dit moment niet optimaal reageert op de standaard aanpak. Dit is <strong>niet</strong> uw schuld en <strong>niet</strong> een kwestie van 'meer wilskracht'. Er spelen biologische factoren mee die we moeten onderzoeken en behandelen. Samen kijken we naar [specifieke factor] en stellen een gericht plan op."
            </blockquote>
          </div>

          <div class="border-2 border-blue-200 rounded-xl p-6">
            <h4 class="font-bold text-blue-700 mb-3"><i class="fas fa-car mr-1"></i>De "Handrem-metafoor"</h4>
            <blockquote class="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-xl italic text-gray-700">
              "Stel dat uw lichaam een auto is die op het moment met de handrem erop rijdt. Wij gaan die handrem eraf halen, zodat u weer normaal kunt rijden. Pas daarna kunnen we kijken naar hoe we de motor optimaliseren."
            </blockquote>
          </div>

          <div class="border-2 border-amber-200 rounded-xl p-6">
            <h4 class="font-bold text-amber-700 mb-3"><i class="fas fa-file-alt mr-1"></i>Patiëntenmateriaal (te ontwikkelen)</h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="flex items-center gap-2"><i class="fas fa-check-circle text-green-500"></i><span>Eetdagboek-template</span></div>
              <div class="flex items-center gap-2"><i class="fas fa-check-circle text-green-500"></i><span>Slaaphygiëne-checklist</span></div>
              <div class="flex items-center gap-2"><i class="fas fa-check-circle text-green-500"></i><span>Stressmanagement-tips</span></div>
              <div class="flex items-center gap-2"><i class="fas fa-check-circle text-green-500"></i><span>Supplement-overzicht per type</span></div>
              <div class="flex items-center gap-2"><i class="fas fa-check-circle text-green-500"></i><span>Recepten-voorbeelden</span></div>
              <div class="flex items-center gap-2"><i class="fas fa-check-circle text-green-500"></i><span>Uitleg labuitslagen voor patiënt</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-lg p-8">
        <h3 class="text-xl font-bold mb-4 text-primary-700"><i class="fas fa-calendar-check mr-2"></i>Follow-up Schema</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="bg-gray-50"><th class="p-3 text-left font-bold">Tijdstip</th><th class="p-3 text-left font-bold">Focus</th><th class="p-3 text-left font-bold">Acties</th></tr></thead>
            <tbody>
              <tr class="border-t"><td class="p-3 font-semibold text-primary-700">2 weken</td><td class="p-3">Adherence, bijwerkingen</td><td class="p-3 text-gray-500">Check supplementen, eetpatroon, ervaringen</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold text-primary-700">6-8 weken</td><td class="p-3">Eerste resultaten</td><td class="p-3 text-gray-500">Wegen, meten, eventueel lab (schildklier, glucose)</td></tr>
              <tr class="border-t"><td class="p-3 font-semibold text-primary-700">3 maanden</td><td class="p-3">Evaluatie protocol</td><td class="p-3 text-gray-500">Gewicht, lichaamssamenstelling, labwaarden, symptomen</td></tr>
              <tr class="border-t bg-gray-50"><td class="p-3 font-semibold text-primary-700">6 maanden</td><td class="p-3">Langetermijn</td><td class="p-3 text-gray-500">Duurzaamheid, onderhoud, eventueel doseringen aanpassen</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </main>

  <script>
    function showSection(id) {
      document.querySelectorAll('.kb-section').forEach(s => s.classList.add('hidden'));
      document.querySelectorAll('.kb-tab').forEach(t => { t.classList.remove('bg-primary-600','text-white'); t.classList.add('bg-gray-200','text-gray-700'); });
      document.getElementById('sec-'+id).classList.remove('hidden');
      const activeTab = document.querySelector('[data-tab="'+id+'"]');
      if (activeTab) { activeTab.classList.remove('bg-gray-200','text-gray-700'); activeTab.classList.add('bg-primary-600','text-white'); }
      window.scrollTo({ top: 200, behavior: 'smooth' });
    }
  </script>
</body></html>`)
})

// =====================================================
// PATIËNTENPORTAAL - APART GEDEELTE
// =====================================================

// =====================================================
// STRIPE PAYMENT ENDPOINTS
// =====================================================

// Stripe REST API helper
async function stripeRequest(secretKey: string, endpoint: string, params: Record<string, string>) {
  const body = new URLSearchParams(params).toString()
  const res = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body
  })
  return res.json() as Promise<any>
}

async function stripeGet(secretKey: string, endpoint: string) {
  const res = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${secretKey}` },
  })
  return res.json() as Promise<any>
}

// Payment types
const PAYMENT_TYPES = {
  analysis: { 
    name: 'Persoonlijke Gezondheidsanalyse', 
    amount: 995, // €9,95 in centen
    description: 'Volledige persoonlijke analyse + eerste advies + lab-aanbeveling'
  },
  protocol: {
    name: 'Persoonlijk Protocol',
    minAmount: 495,  // €4,95
    maxAmount: 2995,  // €29,95
    description: 'Persoonlijk supplement- en voedingsschema op maat'
  }
}

// Create Stripe Checkout Session voor analyse (vast bedrag €9,95)
app.post('/api/payments/create-checkout', async (c) => {
  const { STRIPE_SECRET_KEY } = getEnv(c)
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const { patient_id, payment_type, amount, portal_code } = body

  if (!patient_id || !payment_type) {
    return c.json({ error: 'patient_id en payment_type zijn verplicht' }, 400)
  }

  // Bepaal bedrag
  let paymentAmount: number
  let paymentName: string
  let paymentDesc: string

  if (payment_type === 'analysis') {
    paymentAmount = PAYMENT_TYPES.analysis.amount
    paymentName = PAYMENT_TYPES.analysis.name
    paymentDesc = PAYMENT_TYPES.analysis.description
  } else if (payment_type === 'protocol') {
    const customAmount = parseInt(amount)
    if (!customAmount || customAmount < PAYMENT_TYPES.protocol.minAmount || customAmount > PAYMENT_TYPES.protocol.maxAmount) {
      return c.json({ error: `Bedrag moet tussen €${(PAYMENT_TYPES.protocol.minAmount/100).toFixed(2)} en €${(PAYMENT_TYPES.protocol.maxAmount/100).toFixed(2)} zijn` }, 400)
    }
    paymentAmount = customAmount
    paymentName = PAYMENT_TYPES.protocol.name
    paymentDesc = PAYMENT_TYPES.protocol.description
  } else {
    return c.json({ error: 'Ongeldig payment_type' }, 400)
  }

  // Haal patiënt info op
  const { data: patient } = await db
    .from('patients')
    .select('email, first_name, last_name')
    .eq('id', patient_id)
    .single()

  if (!patient) {
    return c.json({ error: 'Patiënt niet gevonden' }, 404)
  }

  // Bepaal base URL
  const origin = c.req.header('origin') || c.req.header('referer')?.replace(/\/[^/]*$/, '') || 'https://afvallen.netlify.app'

  try {
    // Maak Stripe Checkout Session
    const session = await stripeRequest(STRIPE_SECRET_KEY, '/checkout/sessions', {
      'payment_method_types[0]': 'ideal',
      'payment_method_types[1]': 'card',
      'mode': 'payment',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': paymentAmount.toString(),
      'line_items[0][price_data][product_data][name]': paymentName,
      'line_items[0][price_data][product_data][description]': paymentDesc,
      'line_items[0][quantity]': '1',
      'customer_email': patient.email,
      'success_url': `${origin}/betaling-succes?session_id={CHECKOUT_SESSION_ID}&type=${payment_type}`,
      'cancel_url': `${origin}/menu`,
      'metadata[patient_id]': patient_id,
      'metadata[payment_type]': payment_type,
      'metadata[portal_code]': portal_code || '',
      'locale': 'nl',
    })

    if (session.error) {
      console.error('Stripe error:', session.error)
      return c.json({ error: 'Betaling kon niet worden aangemaakt. Probeer opnieuw.' }, 500)
    }

    // Sla payment record op in Supabase
    await db.from('payments').insert([{
      patient_id,
      stripe_session_id: session.id,
      payment_type,
      amount: paymentAmount,
      currency: 'eur',
      status: 'pending',
    }])

    return c.json({ 
      checkout_url: session.url,
      session_id: session.id
    })

  } catch (err) {
    console.error('Payment error:', err)
    return c.json({ error: 'Er ging iets mis met de betaling. Probeer opnieuw.' }, 500)
  }
})

// Verify payment status
app.get('/api/payments/verify/:sessionId', async (c) => {
  const { STRIPE_SECRET_KEY } = getEnv(c)
  const db = getSupabase(getEnv(c))
  const sessionId = c.req.param('sessionId')

  try {
    const session = await stripeGet(STRIPE_SECRET_KEY, `/checkout/sessions/${sessionId}`)

    if (session.error) {
      return c.json({ error: 'Sessie niet gevonden' }, 404)
    }

    const isPaid = session.payment_status === 'paid'

    // Update payment record in Supabase
    if (isPaid) {
      await db.from('payments').update({
        status: 'paid',
        stripe_payment_intent: session.payment_intent,
        paid_at: new Date().toISOString()
      }).eq('stripe_session_id', sessionId)
    }

    return c.json({
      paid: isPaid,
      payment_type: session.metadata?.payment_type,
      patient_id: session.metadata?.patient_id,
      amount: session.amount_total,
      customer_email: session.customer_email
    })

  } catch (err) {
    console.error('Verify error:', err)
    return c.json({ error: 'Kon betaling niet verifiëren' }, 500)
  }
})

// Check payment status voor een patiënt
app.get('/api/payments/status/:patientId', async (c) => {
  const db = getSupabase(getEnv(c))
  const patientId = c.req.param('patientId')

  const { data: payments } = await db
    .from('payments')
    .select('*')
    .eq('patient_id', patientId)
    .eq('status', 'paid')
    .order('created_at', { ascending: false })

  const analysisPaid = payments?.some((p: any) => p.payment_type === 'analysis') || false
  const protocolPaid = payments?.some((p: any) => p.payment_type === 'protocol') || false

  return c.json({
    analysis_paid: analysisPaid,
    protocol_paid: protocolPaid,
    payments: payments || []
  })
})

// Get Stripe publishable key (voor frontend)
app.get('/api/payments/config', (c) => {
  const { STRIPE_PUBLISHABLE_KEY } = getEnv(c)
  return c.json({ publishableKey: STRIPE_PUBLISHABLE_KEY })
})

// Portal HTML head (eigen branding, geen therapeut-navigatie)
const portalHead = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Grip op je Gewicht - Wetenschappelijke Aanpak</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            portal: { 50:'#f0fdf4',100:'#dcfce7',200:'#bbf7d0',300:'#86efac',400:'#4ade80',500:'#22c55e',600:'#16a34a',700:'#15803d',800:'#166534',900:'#14532d' }
          },
          fontFamily: {
            sans: ['Inter', 'system-ui', 'sans-serif']
          }
        }
      }
    }
  </script>
  <style>
    .fade-in { animation: fadeIn 0.5s ease-out; }
    .fade-in-delay { animation: fadeIn 0.6s ease-out 0.15s both; }
    .fade-in-delay-2 { animation: fadeIn 0.6s ease-out 0.3s both; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
    .card-hover { transition: all 0.3s cubic-bezier(0.4,0,0.2,1); }
    .card-hover:hover { transform: translateY(-4px); box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
    .progress-bar { transition: width 0.5s ease; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.6; } }
    .gradient-text { background: linear-gradient(135deg, #16a34a, #0d9488); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .hero-pattern { background-image: radial-gradient(circle at 20% 50%, rgba(255,255,255,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(255,255,255,0.05) 0%, transparent 40%); }
    .step-line::after { content:''; position:absolute; top:2.5rem; left:50%; width:calc(100% + 2rem); height:2px; background:linear-gradient(90deg,#bbf7d0,#86efac); z-index:0; }
    @media(max-width:768px) { .step-line::after { display:none; } }
  </style>
</head>`

const portalNav = `
<nav class="bg-white/95 backdrop-blur-md border-b border-gray-100 sticky top-0 z-50">
  <div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
    <a href="/" class="flex items-center gap-3 hover:opacity-80 transition">
      <div class="w-10 h-10 bg-gradient-to-br from-portal-500 to-teal-600 rounded-xl flex items-center justify-center">
        <i class="fas fa-leaf text-white text-lg"></i>
      </div>
      <div>
        <h1 class="text-base font-bold text-gray-800 leading-tight">Grip op je Gewicht</h1>
        <p class="text-xs text-gray-400">Fysiopraktijk Zeist</p>
      </div>
    </a>
    <div class="flex items-center gap-3">
      <a href="/" class="hidden sm:inline-flex px-3 py-2 rounded-lg hover:bg-gray-100 text-sm text-gray-600 font-medium transition"><i class="fas fa-home mr-1"></i> Home</a>
      <a href="/aanmelden" class="hidden sm:inline-flex px-3 py-2 rounded-lg hover:bg-gray-100 text-sm text-gray-600 font-medium transition"><i class="fas fa-user-plus mr-1"></i> Aanmelden</a>
      <a href="/inloggen" class="bg-portal-600 text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-portal-700 transition shadow-sm"><i class="fas fa-sign-in-alt mr-1"></i> Inloggen</a>
    </div>
  </div>
</nav>`

// =====================================================
// API: PORTAL ACCESS CODES
// =====================================================

// Zelf-registratie: patiënt maakt zelf een account aan
app.post('/api/portal/register', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const { first_name, last_name, email, gender, date_of_birth, consent_given, consent_timestamp } = body

  // Validatie
  if (!first_name?.trim() || !last_name?.trim() || !email?.trim()) {
    return c.json({ error: 'Voornaam, achternaam en email zijn verplicht.' }, 400)
  }
  if (!consent_given) {
    return c.json({ error: 'Je moet akkoord gaan met alle voorwaarden om door te gaan.' }, 400)
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Voer een geldig emailadres in.' }, 400)
  }

  // Check of email al bestaat
  const { data: existing } = await db
    .from('patients')
    .select('id, portal_code, first_name')
    .eq('email', email.trim().toLowerCase())
    .eq('status', 'active')
    .single()

  if (existing) {
    // Patiënt bestaat al — stuur bestaande code of genereer nieuwe
    if (existing.portal_code) {
      return c.json({ 
        success: true, 
        code: existing.portal_code, 
        patient_name: existing.first_name,
        existing: true,
        message: 'Er bestaat al een account met dit emailadres. Hier is je toegangscode.'
      })
    }
    // Genereer code voor bestaande patiënt zonder code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length))
    
    await db.from('patients').update({ 
      portal_code: code, 
      portal_code_created_at: new Date().toISOString() 
    }).eq('id', existing.id)

    return c.json({ 
      success: true, 
      code, 
      patient_name: existing.first_name,
      existing: true,
      message: 'Er bestaat al een account met dit emailadres. Hier is je nieuwe toegangscode.'
    })
  }

  // Genereer 8-karakter toegangscode
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length))

  // Maak patiënt aan
  const { data: patient, error } = await db
    .from('patients')
    .insert([{
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      email: email.trim().toLowerCase(),
      gender: gender || null,
      date_of_birth: date_of_birth || null,
      status: 'active',
      portal_code: code,
      portal_code_created_at: new Date().toISOString(),
      consent_given: true,
      consent_timestamp: consent_timestamp || new Date().toISOString(),
      consent_ip: c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'unknown'
    }])
    .select()
    .single()

  if (error) {
    console.error('Register error:', error)
    return c.json({ error: 'Er ging iets mis bij het aanmaken. Probeer opnieuw.' }, 500)
  }

  return c.json({ 
    success: true, 
    code, 
    patient_name: first_name.trim(),
    existing: false,
    message: 'Je account is aangemaakt!'
  })
})

app.post('/api/portal/generate-code', async (c) => {
  const db = getSupabase(getEnv(c))
  const { patient_id } = await c.req.json()
  
  // Generate 8-character alphanumeric code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no confusing chars I/O/0/1
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  
  // Try to store in portal_code column; if column doesn't exist, use notes field
  const { data, error } = await db
    .from('patients')
    .update({ portal_code: code, portal_code_created_at: new Date().toISOString() })
    .eq('id', patient_id)
    .select()
    .single()
  
  if (error && error.message?.includes('portal_code')) {
    // Column doesn't exist yet - store in notes as fallback  
    const { data: d2, error: e2 } = await db
      .from('patients')
      .update({ notes: 'PORTAL_CODE:' + code })
      .eq('id', patient_id)
      .select()
      .single()
    if (e2) return c.json({ error: e2.message }, 500)
    return c.json({ code, patient_id })
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ code, patient_id })
})

// Code vergeten — opzoeken via e-mailadres
app.post('/api/portal/forgot-code', async (c) => {
  const db = getSupabase(getEnv(c))
  const { email } = await c.req.json()

  if (!email?.trim()) {
    return c.json({ error: 'Vul je e-mailadres in.' }, 400)
  }

  const cleanEmail = email.trim().toLowerCase()

  // Zoek patiënt op e-mail
  const { data: patient } = await db
    .from('patients')
    .select('id, first_name, portal_code')
    .eq('email', cleanEmail)
    .eq('status', 'active')
    .single()

  if (!patient) {
    // Bewust vaag om geen info te lekken over welke emails bestaan
    return c.json({ 
      success: true, 
      message: 'Als dit e-mailadres bij ons bekend is, wordt de toegangscode getoond.' 
    })
  }

  // Als er geen code is, genereer er een
  let code = patient.portal_code
  if (!code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    code = ''
    for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length))
    
    await db.from('patients').update({ 
      portal_code: code, 
      portal_code_created_at: new Date().toISOString() 
    }).eq('id', patient.id)
  }

  return c.json({ 
    success: true,
    found: true,
    code,
    first_name: patient.first_name,
    message: 'Toegangscode gevonden!'
  })
})

app.post('/api/portal/verify-code', async (c) => {
  const db = getSupabase(getEnv(c))
  const { code } = await c.req.json()
  const upperCode = code.toUpperCase().trim()
  
  // Try portal_code column first
  let { data, error } = await db
    .from('patients')
    .select('id, first_name, last_name, gender, date_of_birth, portal_code')
    .eq('portal_code', upperCode)
    .eq('status', 'active')
    .single()
  
  if (error || !data) {
    // Fallback: check notes field for PORTAL_CODE:XXXXXXXX
    const { data: allPatients } = await db
      .from('patients')
      .select('id, first_name, last_name, gender, date_of_birth, notes')
      .eq('status', 'active')
    
    const found = allPatients?.find(p => p.notes?.includes('PORTAL_CODE:' + upperCode))
    if (!found) return c.json({ error: 'Ongeldige toegangscode' }, 401)
    data = found
  }
  
  return c.json({
    id: data.id,
    patient_id: data.id,
    first_name: data.first_name,
    last_name: data.last_name,
    gender: data.gender,
    date_of_birth: data.date_of_birth
  })
})

// Portal status check (voor menu)
app.get('/api/portal/check-status', async (c) => {
  const db = getSupabase(getEnv(c))
  const code = c.req.query('code')

  if (!code) return c.json({ error: 'Code ontbreekt' }, 400)

  // Zoek patiënt
  const { data: patient } = await db
    .from('patients')
    .select('id')
    .eq('portal_code', code.toUpperCase())
    .eq('status', 'active')
    .single()

  if (!patient) return c.json({ has_assessment: false, review_status: null, has_protocol: false })

  // Check assessment
  const { data: assessment } = await db
    .from('assessments')
    .select('id, review_status')
    .eq('patient_id', patient.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  // Check protocol
  const { data: protocols } = await db
    .from('supplement_protocols')
    .select('id')
    .eq('patient_id', patient.id)
    .limit(1)

  return c.json({
    has_assessment: !!assessment,
    review_status: assessment?.review_status || null,
    has_protocol: (protocols && protocols.length > 0) || false
  })
})

// Portal assessment submission (from patient side)
app.post('/api/portal/assessment', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const upperCode = body.portal_code?.toUpperCase()?.trim()
  
  // Verify portal code (try column, then notes fallback)
  let patient: any = null
  const { data: p1 } = await db
    .from('patients')
    .select('id, portal_code')
    .eq('portal_code', upperCode)
    .eq('status', 'active')
    .single()
  
  if (p1) {
    patient = p1
  } else {
    const { data: allP } = await db.from('patients').select('id, notes').eq('status', 'active')
    const found = allP?.find(p => p.notes?.includes('PORTAL_CODE:' + upperCode))
    if (found) patient = found
  }
  
  if (!patient) return c.json({ error: 'Ongeldige toegangscode' }, 401)
  
  // Run classification
  const classification = classifyPatient(body.responses as TriageResponses)
  const riskProfile = generateRiskProfile(
    classification.categories,
    classification.riskScores,
    body.responses
  )
  
  const assessmentData = {
    patient_id: patient.id,
    assessment_type: 'standard',  // portal self-assessment (constraint: quick/standard/deep)
    determined_type: classification.primaryType,
    categories: classification.categories,
    risk_scores: classification.riskScores,
    responses: body.responses,
    risk_profile: riskProfile,
    completed: true,
    review_status: 'pending_review'
  }
  
  const { data, error } = await db
    .from('assessments')
    .insert([assessmentData])
    .select()
    .single()
  
  if (error) return c.json({ error: error.message }, 500)
  
  // Update patient type
  await db
    .from('patients')
    .update({ patient_type: classification.primaryType.charAt(0).toUpperCase() })
    .eq('id', patient.id)
  
  // Generate lab recommendations
  const categoryIds = classification.categories.map(cat => cat.id)
  const labPackage = getLabRecommendations(categoryIds, body.responses)
  
  await db
    .from('lab_tests')
    .insert([{
      patient_id: patient.id,
      assessment_id: data.id,
      test_package: labPackage.name,
      recommended_tests: labPackage.tests,
      blood_tests: labPackage.bloodTests,
      stool_tests: labPackage.stoolTests,
      other_tests: labPackage.otherTests,
      urgency: labPackage.urgency,
      rationale: labPackage.rationale,
      status: 'recommended'
    }])
  
  return c.json({
    success: true,
    assessment_id: data.id,
    responses: body.responses,
    review_status: 'pending_review',
    message: 'Uw vragenlijst is ontvangen. Uw therapeut beoordeelt uw antwoorden en neemt contact met u op.'
  }, 201)
})

// Portal lab document upload (store as base64 in Supabase since no R2/Storage)
app.post('/api/portal/lab-upload', async (c) => {
  const db = getSupabase(getEnv(c))
  const body = await c.req.json()
  const upperCode = body.portal_code?.toUpperCase()?.trim()
  
  // Verify portal code (try column, then notes fallback)
  let patient: any = null
  const { data: p1 } = await db
    .from('patients')
    .select('id, portal_code')
    .eq('portal_code', upperCode)
    .eq('status', 'active')
    .single()
  
  if (p1) {
    patient = p1
  } else {
    const { data: allP } = await db.from('patients').select('id, notes').eq('status', 'active')
    const found = allP?.find(p => p.notes?.includes('PORTAL_CODE:' + upperCode))
    if (found) patient = found
  }
  
  if (!patient) return c.json({ error: 'Ongeldige toegangscode' }, 401)
  
  // Controleer of bestandsdata aanwezig is
  if (!body.file_data) {
    return c.json({ error: 'Geen bestandsdata ontvangen. Selecteer een bestand.' }, 400)
  }

  // Sla upload metadata op in progress_tracking
  const { data, error } = await db
    .from('progress_tracking')
    .insert([{
      patient_id: patient.id,
      measurement_date: new Date().toISOString().split('T')[0],
      notes: `📎 Lab-document geüpload via portaal: ${body.file_name || 'onbekend'} (${body.file_type || 'onbekend'}, ${((body.file_size || 0) / 1024).toFixed(0)} KB) - ${new Date().toLocaleString('nl-NL')}${body.notes ? '\n📝 Opmerking: ' + body.notes : ''}`
    }])
    .select()
    .single()

  if (error) {
    console.error('Lab upload error:', error)
    return c.json({ error: 'Fout bij opslaan. Probeer opnieuw.' }, 500)
  }

  // Sla de base64 data op in een apart lab_uploads record (als die tabel bestaat)
  try {
    await db.from('lab_uploads').insert([{
      patient_id: patient.id,
      file_name: body.file_name,
      file_type: body.file_type,
      file_size: body.file_size,
      file_data: body.file_data,
      notes: body.notes || null,
      status: 'pending'
    }])
  } catch(e) {
    // lab_uploads tabel bestaat mogelijk nog niet - geen probleem, metadata is opgeslagen
    console.log('lab_uploads tabel niet beschikbaar, metadata opgeslagen in progress_tracking')
  }

  return c.json({ success: true, message: 'Document succesvol ontvangen! Uw therapeut wordt geïnformeerd en verwerkt de resultaten in uw dossier.' })
})

// =====================================================
// PORTAL FRONTEND PAGES
// =====================================================

// LANDINGSPAGINA
app.get('/', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen font-sans">
  ${portalNav}

  <!-- HERO -->
  <section class="hero-pattern bg-gradient-to-br from-portal-700 via-portal-800 to-teal-900 text-white py-20 md:py-28">
    <div class="max-w-6xl mx-auto px-4">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
        <div class="fade-in">
          <div class="inline-flex items-center gap-2 bg-white/10 backdrop-blur px-4 py-2 rounded-full text-sm mb-6 border border-white/10">
            <i class="fas fa-microscope"></i>
            <span>Wetenschappelijk onderbouwd</span>
          </div>
          <h1 class="text-4xl md:text-5xl lg:text-[3.4rem] font-black leading-[1.1] mb-6 tracking-tight">
            Grip op je Gewicht<br>
            <span class="text-portal-300">Een blauwdruk voor<br>blijvend resultaat</span>
          </h1>
          <p class="text-lg text-white/85 mb-8 leading-relaxed max-w-lg">
            Heb je al talloze pogingen gedaan om af te vallen, maar val je steeds terug? Of wil je dit keer direct de juiste aanpak kiezen zonder te gokken?
          </p>
          <p class="text-base text-portal-200 mb-10 leading-relaxed max-w-lg font-medium">
            <strong class="text-white">Stoppen met raden, starten met weten.</strong> Door middel van diepgaande assessments en laboratoriummetingen bepalen we exact wat jouw lichaam nodig heeft.
          </p>
          <div class="flex flex-col sm:flex-row gap-4">
            <a href="/inloggen" class="bg-white text-portal-700 px-8 py-4 rounded-xl font-bold text-lg hover:bg-portal-50 transition text-center shadow-lg hover:shadow-xl">
              <i class="fas fa-arrow-right mr-2"></i>Start mijn analyse
            </a>
            <a href="#waarom" class="border-2 border-white/25 px-8 py-4 rounded-xl font-semibold text-lg hover:bg-white/10 transition text-center">
              <i class="fas fa-info-circle mr-2"></i>Hoe het werkt
            </a>
          </div>
        </div>
        <div class="hidden lg:block fade-in-delay">
          <div class="bg-white/[0.07] backdrop-blur-sm rounded-3xl p-8 border border-white/10 space-y-5">
            <div class="flex items-start gap-4"><div class="w-12 h-12 bg-portal-500/30 rounded-2xl flex items-center justify-center flex-shrink-0"><i class="fas fa-clipboard-check text-lg"></i></div><div><p class="font-bold text-base">Wetenschappelijk Assessment</p><p class="text-sm text-white/60 mt-1">Vragenlijsten die jouw unieke profiel in kaart brengen</p></div></div>
            <div class="flex items-start gap-4"><div class="w-12 h-12 bg-teal-500/30 rounded-2xl flex items-center justify-center flex-shrink-0"><i class="fas fa-flask text-lg"></i></div><div><p class="font-bold text-base">Laboratoriumanalyse</p><p class="text-sm text-white/60 mt-1">Bloed- en ontlastingsonderzoek voor een compleet beeld</p></div></div>
            <div class="flex items-start gap-4"><div class="w-12 h-12 bg-emerald-500/30 rounded-2xl flex items-center justify-center flex-shrink-0"><i class="fas fa-chart-line text-lg"></i></div><div><p class="font-bold text-base">Data-gedreven voortgang</p><p class="text-sm text-white/60 mt-1">Meetbare resultaten in heldere grafieken</p></div></div>
            <div class="flex items-start gap-4"><div class="w-12 h-12 bg-green-500/30 rounded-2xl flex items-center justify-center flex-shrink-0"><i class="fas fa-user-md text-lg"></i></div><div><p class="font-bold text-base">Persoonlijk plan op maat</p><p class="text-sm text-white/60 mt-1">Voeding, supplementen en leefstijl specifiek voor jou</p></div></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- WAAROM DIT WERKT -->
  <section id="waarom" class="py-20 bg-white">
    <div class="max-w-6xl mx-auto px-4">
      <div class="text-center mb-14">
        <p class="text-portal-600 font-semibold text-sm uppercase tracking-wider mb-3">De methode</p>
        <h2 class="text-3xl md:text-4xl font-black text-gray-900 mb-4">Waarom dit systeem w&eacute;l werkt</h2>
        <p class="text-gray-500 max-w-2xl mx-auto text-lg">Afvallen is geen kwestie van "minder eten en meer bewegen" alleen. Het gaat over hormonale balans, stofwisselingstypes en complexe biochemische processen.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div class="bg-gradient-to-b from-portal-50 to-white p-8 rounded-2xl border border-portal-100 card-hover">
          <div class="w-14 h-14 bg-portal-100 rounded-2xl flex items-center justify-center mb-5"><i class="fas fa-clipboard-check text-portal-600 text-2xl"></i></div>
          <h3 class="font-bold text-gray-900 text-lg mb-3">Wetenschappelijk Assessment</h3>
          <p class="text-gray-500 leading-relaxed">De vragenlijsten vormen de basis voor jouw unieke profiel. Geen giswerk, maar gerichte screening op 7 mogelijke oorzaken.</p>
        </div>
        <div class="bg-gradient-to-b from-teal-50 to-white p-8 rounded-2xl border border-teal-100 card-hover">
          <div class="w-14 h-14 bg-teal-100 rounded-2xl flex items-center justify-center mb-5"><i class="fas fa-flask text-teal-600 text-2xl"></i></div>
          <h3 class="font-bold text-gray-900 text-lg mb-3">Noodzakelijke Baselinemeting</h3>
          <p class="text-gray-500 leading-relaxed">Om een zuiver beeld te krijgen van jouw startpunt is laboratoriumonderzoek een essentieel onderdeel. Heb je al recente resultaten? Upload ze direct in het portaal.</p>
        </div>
        <div class="bg-gradient-to-b from-emerald-50 to-white p-8 rounded-2xl border border-emerald-100 card-hover">
          <div class="w-14 h-14 bg-emerald-100 rounded-2xl flex items-center justify-center mb-5"><i class="fas fa-chart-line text-emerald-600 text-2xl"></i></div>
          <h3 class="font-bold text-gray-900 text-lg mb-3">Data-gedreven Voortgang</h3>
          <p class="text-gray-500 leading-relaxed">We meten niet alleen je gewicht. BMI, vetpercentage en slaapkwaliteit worden nauwgezet bijgehouden in heldere grafieken. Zo zie je exact wat er verandert.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- PERSOONLIJK PLAN -->
  <section class="py-20 bg-gray-50">
    <div class="max-w-6xl mx-auto px-4">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
        <div>
          <p class="text-portal-600 font-semibold text-sm uppercase tracking-wider mb-3">Het resultaat</p>
          <h2 class="text-3xl md:text-4xl font-black text-gray-900 mb-6">Jouw Persoonlijke<br>Plan van Aanpak</h2>
          <p class="text-gray-500 text-lg mb-8 leading-relaxed">Het eindresultaat van de analyse is een volledig gepersonaliseerd programma. Geen algemene tips, maar een <strong class="text-gray-700">concreet plan op maat</strong>.</p>
          <div class="space-y-5">
            <div class="flex items-start gap-4">
              <div class="w-11 h-11 bg-green-100 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"><i class="fas fa-utensils text-green-600"></i></div>
              <div><h4 class="font-bold text-gray-800 mb-1">Voeding</h4><p class="text-gray-500 text-sm leading-relaxed">Precies die brandstof die jouw specifieke metabolisme nodig heeft.</p></div>
            </div>
            <div class="flex items-start gap-4">
              <div class="w-11 h-11 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"><i class="fas fa-capsules text-blue-600"></i></div>
              <div><h4 class="font-bold text-gray-800 mb-1">Supplementen</h4><p class="text-gray-500 text-sm leading-relaxed">Gerichte ondersteuning op basis van jouw tekorten en labwaarden.</p></div>
            </div>
            <div class="flex items-start gap-4">
              <div class="w-11 h-11 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"><i class="fas fa-heart-pulse text-amber-600"></i></div>
              <div><h4 class="font-bold text-gray-800 mb-1">Leefstijlfactoren</h4><p class="text-gray-500 text-sm leading-relaxed">Praktische adviezen over beweging, stressmanagement en herstel.</p></div>
            </div>
          </div>
        </div>
        <div class="bg-white rounded-3xl shadow-lg border border-gray-100 overflow-hidden">
          <div class="bg-gradient-to-r from-portal-600 to-teal-600 p-6 text-white">
            <div class="flex items-center gap-3 mb-1"><i class="fas fa-file-medical text-xl"></i><h3 class="font-bold text-lg">Voorbeeld protocol</h3></div>
            <p class="text-white/70 text-sm">Gegenereerd op basis van jouw persoonlijke data</p>
          </div>
          <div class="p-6 space-y-4">
            <div class="flex items-center gap-3 text-sm"><span class="w-2 h-2 bg-green-500 rounded-full"></span><span class="text-gray-600">Omega-3 EPA/DHA &mdash; 2000mg/dag</span></div>
            <div class="flex items-center gap-3 text-sm"><span class="w-2 h-2 bg-green-500 rounded-full"></span><span class="text-gray-600">Vitamine D3 &mdash; 3000 IE/dag</span></div>
            <div class="flex items-center gap-3 text-sm"><span class="w-2 h-2 bg-green-500 rounded-full"></span><span class="text-gray-600">Magnesium bisglycinaat &mdash; 400mg/dag</span></div>
            <div class="flex items-center gap-3 text-sm"><span class="w-2 h-2 bg-blue-500 rounded-full"></span><span class="text-gray-600">Koolhydraatarm voedingsschema (fase 1)</span></div>
            <div class="flex items-center gap-3 text-sm"><span class="w-2 h-2 bg-amber-500 rounded-full"></span><span class="text-gray-600">Slaaphygi&euml;ne protocol + ademhalingsoefeningen</span></div>
            <div class="border-t pt-4 mt-2"><p class="text-xs text-gray-400 italic"><i class="fas fa-info-circle mr-1"></i>Dit is een voorbeeld. Jouw protocol wordt volledig afgestemd op jouw labwaarden en assessment.</p></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- HOE HET PROCES WERKT -->
  <section class="py-20 bg-white">
    <div class="max-w-6xl mx-auto px-4">
      <div class="text-center mb-14">
        <p class="text-portal-600 font-semibold text-sm uppercase tracking-wider mb-3">Het proces</p>
        <h2 class="text-3xl md:text-4xl font-black text-gray-900 mb-4">Van data naar resultaat</h2>
        <p class="text-gray-500 max-w-2xl mx-auto text-lg">Jij levert de gegevens, de expert doet de diepgaande analyse.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-8">
        <div class="text-center relative">
          <div class="relative z-10 w-16 h-16 bg-portal-600 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-portal-200">
            <i class="fas fa-clipboard-list text-white text-xl"></i>
          </div>
          <div class="bg-portal-50 rounded-xl px-4 py-3 mb-3 inline-block"><span class="text-portal-700 font-black text-sm">STAP 1</span></div>
          <h3 class="font-bold text-gray-800 mb-2">Digitale Intake</h3>
          <p class="text-sm text-gray-500">Jij vult de uitgebreide vragenlijsten in via dit portaal.</p>
        </div>
        <div class="text-center relative">
          <div class="relative z-10 w-16 h-16 bg-teal-600 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-teal-200">
            <i class="fas fa-vials text-white text-xl"></i>
          </div>
          <div class="bg-teal-50 rounded-xl px-4 py-3 mb-3 inline-block"><span class="text-teal-700 font-black text-sm">STAP 2</span></div>
          <h3 class="font-bold text-gray-800 mb-2">Lab-Analyse</h3>
          <p class="text-sm text-gray-500">Op basis van jouw profiel wordt gericht laboratoriumonderzoek uitgevoerd, of jouw bestaande resultaten geanalyseerd.</p>
        </div>
        <div class="text-center relative">
          <div class="relative z-10 w-16 h-16 bg-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-emerald-200">
            <i class="fas fa-user-md text-white text-xl"></i>
          </div>
          <div class="bg-emerald-50 rounded-xl px-4 py-3 mb-3 inline-block"><span class="text-emerald-700 font-black text-sm">STAP 3</span></div>
          <h3 class="font-bold text-gray-800 mb-2">Expert Analyse</h3>
          <p class="text-sm text-gray-500">Jouw complete dataset wordt geanalyseerd door een specialist met een unieke combinatie van expertise.</p>
        </div>
        <div class="text-center relative">
          <div class="relative z-10 w-16 h-16 bg-green-600 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-green-200">
            <i class="fas fa-chart-line text-white text-xl"></i>
          </div>
          <div class="bg-green-50 rounded-xl px-4 py-3 mb-3 inline-block"><span class="text-green-700 font-black text-sm">STAP 4</span></div>
          <h3 class="font-bold text-gray-800 mb-2">Monitoring</h3>
          <p class="text-sm text-gray-500">We houden de voortgang bij in overzichtelijke grafieken, zodat we altijd kunnen bijsturen.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- EXPERT -->
  <section class="py-20 bg-gray-50">
    <div class="max-w-4xl mx-auto px-4">
      <div class="bg-white rounded-3xl shadow-lg border border-gray-100 overflow-hidden">
        <div class="grid grid-cols-1 md:grid-cols-3">
          <div class="bg-gradient-to-b from-portal-600 to-teal-700 p-8 flex flex-col items-center justify-center text-white text-center">
            <div class="w-24 h-24 bg-white/15 rounded-full flex items-center justify-center mb-4 border-2 border-white/20">
              <i class="fas fa-user-md text-4xl"></i>
            </div>
            <h3 class="font-bold text-xl mb-1">Marc</h3>
            <p class="text-white/75 text-sm">Fysiopraktijk Zeist</p>
          </div>
          <div class="md:col-span-2 p-8">
            <p class="text-portal-600 font-semibold text-sm uppercase tracking-wider mb-3">De expert achter de analyse</p>
            <h3 class="text-2xl font-black text-gray-900 mb-4">Unieke combinatie van expertise</h3>
            <p class="text-gray-500 mb-6 leading-relaxed">Jouw volledige dataset wordt geanalyseerd door een specialist met een zeldzame drievoudige expertise:</p>
            <div class="space-y-3">
              <div class="flex items-center gap-3"><div class="w-8 h-8 bg-portal-100 rounded-lg flex items-center justify-center"><i class="fas fa-graduation-cap text-portal-600 text-sm"></i></div><p class="text-gray-700 font-medium text-sm">Orthomoleculair Natuurgeneeskundig Therapeut <span class="text-gray-400">(HBO)</span></p></div>
              <div class="flex items-center gap-3"><div class="w-8 h-8 bg-teal-100 rounded-lg flex items-center justify-center"><i class="fas fa-brain text-teal-600 text-sm"></i></div><p class="text-gray-700 font-medium text-sm">KPNI-specialist <span class="text-gray-400">(Klinische Psycho-Neuro-Immunologie)</span></p></div>
              <div class="flex items-center gap-3"><div class="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center"><i class="fas fa-hands-helping text-blue-600 text-sm"></i></div><p class="text-gray-700 font-medium text-sm">Fysiotherapeut <span class="text-gray-400">met 30 jaar ervaring</span></p></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- VOOR WIE -->
  <section class="py-20 bg-white">
    <div class="max-w-6xl mx-auto px-4">
      <div class="text-center mb-14">
        <p class="text-portal-600 font-semibold text-sm uppercase tracking-wider mb-3">Herkenbaar?</p>
        <h2 class="text-3xl md:text-4xl font-black text-gray-900 mb-4">Voor wie is dit?</h2>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div class="bg-portal-50 rounded-2xl p-8 border border-portal-100 card-hover">
          <div class="w-12 h-12 bg-portal-200 rounded-xl flex items-center justify-center mb-5"><i class="fas fa-seedling text-portal-700 text-xl"></i></div>
          <h3 class="font-bold text-gray-900 mb-3">Een gezonde start</h3>
          <p class="text-gray-500 leading-relaxed">Mensen die een gezonde start willen maken met een plan dat gebaseerd is op <strong class="text-gray-700">feiten, niet op rages</strong>.</p>
        </div>
        <div class="bg-amber-50 rounded-2xl p-8 border border-amber-100 card-hover">
          <div class="w-12 h-12 bg-amber-200 rounded-xl flex items-center justify-center mb-5"><i class="fas fa-rotate text-amber-700 text-xl"></i></div>
          <h3 class="font-bold text-gray-900 mb-3">Alles al geprobeerd</h3>
          <p class="text-gray-500 leading-relaxed">Mensen die "alles al geprobeerd hebben" en nu de <strong class="text-gray-700">biologische oorzaak</strong> van hun stagnatie willen aanpakken.</p>
        </div>
        <div class="bg-teal-50 rounded-2xl p-8 border border-teal-100 card-hover">
          <div class="w-12 h-12 bg-teal-200 rounded-xl flex items-center justify-center mb-5"><i class="fas fa-microscope text-teal-700 text-xl"></i></div>
          <h3 class="font-bold text-gray-900 mb-3">Data-gedreven aanpak</h3>
          <p class="text-gray-500 leading-relaxed">Iedereen die bereid is via data naar de kern van hun gezondheid te kijken voor een <strong class="text-gray-700">resultaat dat w&eacute;l blijft</strong>.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- DISCLAIMER -->
  <section id="disclaimer" class="py-16 bg-gray-50">
    <div class="max-w-3xl mx-auto px-4">
      <div class="bg-white rounded-2xl shadow-sm border p-8">
        <div class="flex items-center gap-3 mb-6">
          <div class="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center"><i class="fas fa-exclamation-triangle text-yellow-600 text-xl"></i></div>
          <h2 class="text-2xl font-black text-gray-800">Disclaimer</h2>
        </div>
        <div class="space-y-4 text-gray-600 text-sm leading-relaxed">
          <p><strong>Medische informatie:</strong> De informatie op dit portaal en de resultaten van de vragenlijst zijn bedoeld als hulpmiddel voor uw therapeut en zijn <strong>geen medisch advies of diagnose</strong>. De resultaten vervangen niet het oordeel van een arts of specialist.</p>
          <p><strong>Professionele begeleiding:</strong> De analyse wordt altijd door uw therapeut Marc beoordeeld en besproken. Wijzigingen in medicatie, supplementen of voeding dienen altijd in overleg met uw behandelend arts plaats te vinden.</p>
          <p><strong>Geen vervanging:</strong> Dit portaal vervangt geen consult bij uw huisarts, specialist of andere zorgverlener. Bij acute klachten neem altijd contact op met uw huisarts of bel 112.</p>
          <p><strong>Gegevensbescherming:</strong> Uw antwoorden worden veilig opgeslagen en zijn uitsluitend toegankelijk voor u en uw therapeut. Wij verwerken uw gegevens conform de AVG (Algemene Verordening Gegevensbescherming). Uw gegevens worden niet gedeeld met derden.</p>
          <p><strong>Wetenschappelijke basis:</strong> De vragenlijst en categorisatie zijn gebaseerd op orthomoleculaire en functionele geneeskunde principes. De lab-referentiewaarden zijn <em>optimale</em> ranges en worden gebruikt voor preventieve gezondheidsoptimalisatie.</p>
          <p><strong>Supplementen:</strong> Aanbevolen supplementen zijn orthomoleculaire adviezen en geen geneesmiddelen. Raadpleeg bij twijfel altijd uw arts, met name bij zwangerschap, borstvoeding, of gebruik van medicijnen.</p>
        </div>
        <div class="mt-6 pt-4 border-t">
          <p class="text-xs text-gray-400"><i class="fas fa-user-md mr-1"></i> Marc - Fysiotherapeut, Orthomoleculair Therapeut &amp; KPNI-specialist | Fysiopraktijk Zeist</p>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="py-16 hero-pattern bg-gradient-to-br from-portal-700 via-portal-800 to-teal-900 text-white">
    <div class="max-w-3xl mx-auto px-4 text-center">
      <h2 class="text-3xl md:text-4xl font-black mb-4">Krijg grip op je biologie</h2>
      <p class="text-white/80 text-lg mb-10 max-w-xl mx-auto">Start vandaag nog met jouw persoonlijke analyse. Meld je gratis aan en ontdek wat jouw lichaam nodig heeft.</p>
      <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
        <a href="/aanmelden" class="bg-white text-portal-700 px-10 py-4 rounded-xl font-bold text-lg hover:bg-portal-50 transition shadow-lg hover:shadow-xl inline-block">
          <i class="fas fa-user-plus mr-2"></i>Gratis aanmelden
        </a>
        <a href="/inloggen" class="border-2 border-white/40 text-white px-8 py-4 rounded-xl font-semibold text-lg hover:bg-white/10 transition inline-block">
          <i class="fas fa-sign-in-alt mr-2"></i>Ik heb al een code
        </a>
      </div>
      <p class="text-sm text-white/50 mt-6">Geen account nodig — alleen je basisgegevens. Binnen 2 minuten klaar.</p>
    </div>
  </section>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-gray-400 py-8">
    <div class="max-w-6xl mx-auto px-4 text-center">
      <p class="text-sm">&copy; ${new Date().getFullYear()} Fysiopraktijk Zeist</p>
      <p class="text-xs mt-2">Fysiotherapie &bull; Orthomoleculaire Therapie &bull; KPNI | <a href="#disclaimer" class="underline hover:text-white transition">Disclaimer</a></p>
    </div>
  </footer>
</body></html>`)
})

// AANMELD PAGINA
app.get('/aanmelden', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-lg mx-auto px-4 py-12">
    
    <!-- Aanmeldformulier -->
    <div id="register-form-container" class="bg-white rounded-2xl shadow-lg p-8 fade-in">
      <div class="text-center mb-8">
        <div class="w-20 h-20 bg-portal-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-user-plus text-portal-600 text-3xl"></i>
        </div>
        <h2 class="text-2xl font-black text-gray-800">Gratis aanmelden</h2>
        <p class="text-gray-500 mt-2">Start je persoonlijke analyse. Vul je gegevens in en ontvang direct je toegangscode.</p>
      </div>
      
      <div id="reg-error" class="hidden bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-sm mb-6"></div>

      <form id="register-form" class="space-y-5">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-1.5">Voornaam <span class="text-red-400">*</span></label>
            <input type="text" id="reg-first-name" required placeholder="Bijv. Jan"
              class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-portal-500 focus:border-portal-500 transition text-gray-800">
          </div>
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-1.5">Achternaam <span class="text-red-400">*</span></label>
            <input type="text" id="reg-last-name" required placeholder="Bijv. de Vries"
              class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-portal-500 focus:border-portal-500 transition text-gray-800">
          </div>
        </div>

        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1.5">Email <span class="text-red-400">*</span></label>
          <input type="email" id="reg-email" required placeholder="jan.devries@email.nl"
            class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-portal-500 focus:border-portal-500 transition text-gray-800">
          <p class="text-xs text-gray-400 mt-1">Je email wordt gebruikt als je je code kwijtraakt</p>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-1.5">Geslacht</label>
            <select id="reg-gender"
              class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-portal-500 focus:border-portal-500 transition text-gray-800 bg-white">
              <option value="">Selecteer...</option>
              <option value="male">Man</option>
              <option value="female">Vrouw</option>
              <option value="other">Anders</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-1.5">Geboortedatum</label>
            <input type="date" id="reg-dob"
              class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-portal-500 focus:border-portal-500 transition text-gray-800">
          </div>
        </div>

        <div class="bg-gray-50 rounded-xl p-5 border space-y-4">
          <p class="text-sm font-bold text-gray-700"><i class="fas fa-file-contract mr-1"></i> Toestemming & voorwaarden</p>
          
          <label class="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" id="reg-consent-data" required class="mt-1 w-4 h-4 rounded border-gray-300 text-portal-600 focus:ring-portal-500">
            <span class="text-sm text-gray-600"><strong>Gegevensverwerking (AVG):</strong> Ik geef toestemming voor het verwerken van mijn persoonsgegevens en gezondheidsgegevens ten behoeve van de gezondheidsanalyse. Ik begrijp dat mijn gegevens veilig worden opgeslagen, uitsluitend worden gebruikt voor mijn persoonlijke analyse en niet worden gedeeld met derden. Ik kan mijn gegevens op elk moment laten verwijderen.</span>
          </label>

          <label class="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" id="reg-consent-medical" required class="mt-1 w-4 h-4 rounded border-gray-300 text-portal-600 focus:ring-portal-500">
            <span class="text-sm text-gray-600"><strong>Medische disclaimer:</strong> Ik begrijp dat deze analyse <em>geen medisch advies, diagnose of behandeling</em> is en niet het oordeel van een arts vervangt. De resultaten zijn bedoeld als aanvullende informatie op basis van orthomoleculaire en functionele geneeskunde principes. Bij acute klachten neem ik contact op met mijn huisarts of bel 112.</span>
          </label>

          <label class="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" id="reg-consent-liability" required class="mt-1 w-4 h-4 rounded border-gray-300 text-portal-600 focus:ring-portal-500">
            <span class="text-sm text-gray-600"><strong>Aansprakelijkheid:</strong> Ik begrijp en accepteer dat Fysiopraktijk Zeist en de betrokken therapeuten niet aansprakelijk zijn voor enige directe of indirecte schade die voortvloeit uit het gebruik van deze analyse, de gegeven adviezen of aanbevolen supplementen. Ik ben zelf verantwoordelijk voor het raadplegen van mijn arts bij wijzigingen in medicatie of leefstijl.</span>
          </label>

          <p class="text-xs text-gray-400 mt-2">Door aan te melden ga je akkoord met ons <a href="/privacybeleid" target="_blank" class="text-portal-600 underline">privacybeleid</a> en onze <a href="/voorwaarden" target="_blank" class="text-portal-600 underline">algemene voorwaarden</a>.</p>
        </div>

        <button type="submit" id="reg-btn" class="w-full bg-portal-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-portal-700 transition shadow-lg shadow-portal-200">
          <i class="fas fa-arrow-right mr-2"></i>Aanmelden & code ontvangen
        </button>
      </form>

      <div class="mt-6 pt-6 border-t text-center">
        <p class="text-sm text-gray-400">Al aangemeld?</p>
        <a href="/inloggen" class="text-sm text-portal-600 font-semibold hover:text-portal-700 mt-1 inline-block"><i class="fas fa-sign-in-alt mr-1"></i>Inloggen met je code</a>
      </div>
    </div>

    <!-- Succespagina (verborgen) -->
    <div id="register-success" class="hidden fade-in">
      <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
        <div class="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <i class="fas fa-check-circle text-green-500 text-4xl"></i>
        </div>
        <h2 class="text-2xl font-black text-gray-800 mb-2">Welkom, <span id="success-name"></span>!</h2>
        <p id="success-message" class="text-gray-500 mb-6"></p>
        
        <div class="bg-portal-50 border-2 border-portal-200 rounded-2xl p-6 mb-6">
          <p class="text-sm font-semibold text-portal-700 mb-2">Jouw persoonlijke toegangscode:</p>
          <div class="flex items-center justify-center gap-3">
            <span id="success-code" class="text-4xl font-mono font-black tracking-[0.2em] text-portal-700"></span>
            <button onclick="copyCode()" class="text-portal-500 hover:text-portal-700 transition" title="Kopieer code">
              <i class="fas fa-copy text-xl"></i>
            </button>
          </div>
          <p class="text-xs text-portal-600 mt-3"><i class="fas fa-info-circle mr-1"></i>Bewaar deze code goed — je hebt hem nodig om in te loggen</p>
        </div>

        <a href="/inloggen" class="inline-block bg-portal-600 text-white px-10 py-4 rounded-xl font-bold text-lg hover:bg-portal-700 transition shadow-lg">
          <i class="fas fa-arrow-right mr-2"></i>Direct inloggen & starten
        </a>

        <div class="mt-6 pt-6 border-t">
          <p class="text-xs text-gray-400"><i class="fas fa-shield-alt mr-1"></i>Je gegevens worden veilig opgeslagen en versleuteld verzonden (HTTPS)</p>
        </div>
      </div>
    </div>
  </main>

  <script>
    function copyCode() {
      const code = document.getElementById('success-code').textContent;
      navigator.clipboard.writeText(code);
      const btn = event.currentTarget;
      btn.innerHTML = '<i class="fas fa-check text-xl text-green-500"></i>';
      setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy text-xl"></i>'; }, 2000);
    }

    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('reg-btn');
      const errDiv = document.getElementById('reg-error');
      errDiv.classList.add('hidden');

      // Validatie
      const consentData = document.getElementById('reg-consent-data').checked;
      const consentMedical = document.getElementById('reg-consent-medical').checked;
      const consentLiability = document.getElementById('reg-consent-liability').checked;
      if (!consentData || !consentMedical || !consentLiability) {
        errDiv.textContent = 'Je moet alle drie de voorwaarden accepteren om door te gaan.';
        errDiv.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Bezig met aanmelden...';

      try {
        const res = await fetch('/api/portal/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            first_name: document.getElementById('reg-first-name').value,
            last_name: document.getElementById('reg-last-name').value,
            email: document.getElementById('reg-email').value,
            gender: document.getElementById('reg-gender').value || null,
            date_of_birth: document.getElementById('reg-dob').value || null,
            consent_given: true,
            consent_timestamp: new Date().toISOString(),
            consent_details: {
              data_processing: consentData,
              medical_disclaimer: consentMedical,
              liability_waiver: consentLiability
            }
          })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          // Toon succespagina
          document.getElementById('success-name').textContent = data.patient_name;
          document.getElementById('success-code').textContent = data.code;
          document.getElementById('success-message').textContent = data.message;
          document.getElementById('register-form-container').classList.add('hidden');
          document.getElementById('register-success').classList.remove('hidden');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          errDiv.textContent = data.error || 'Er ging iets mis. Probeer opnieuw.';
          errDiv.classList.remove('hidden');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-arrow-right mr-2"></i>Aanmelden & code ontvangen';
        }
      } catch(err) {
        errDiv.textContent = 'Verbindingsfout. Controleer je internetverbinding en probeer opnieuw.';
        errDiv.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-arrow-right mr-2"></i>Aanmelden & code ontvangen';
      }
    });
  </script>
</body></html>`)
})

// PRIVACYBELEID PAGINA
app.get('/privacybeleid', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-3xl mx-auto px-4 py-12">
    <div class="bg-white rounded-2xl shadow-lg p-8 md:p-12">
      <div class="mb-8">
        <a href="/" class="text-portal-600 hover:text-portal-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar home</a>
      </div>
      
      <h1 class="text-3xl font-black text-gray-800 mb-2"><i class="fas fa-shield-alt text-portal-600 mr-2"></i>Privacybeleid</h1>
      <p class="text-sm text-gray-400 mb-8">Laatst bijgewerkt: 10 maart 2026</p>

      <div class="prose max-w-none space-y-6 text-gray-700 leading-relaxed">
        
        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-building mr-2 text-portal-500"></i>1. Verantwoordelijke</h2>
          <p>Fysiopraktijk Zeist, gevestigd te Zeist, is verantwoordelijk voor de verwerking van persoonsgegevens zoals beschreven in dit privacybeleid. De praktijk wordt geleid door Marc, fysiotherapeut en orthomoleculair therapeut.</p>
          <div class="bg-gray-50 rounded-lg p-4 mt-3">
            <p class="text-sm"><strong>Contactgegevens:</strong><br>
            Fysiopraktijk Zeist<br>
            E-mail: info@fysiopraktijkzeist.nl<br>
            Website: fysiopraktijkzeist.nl</p>
          </div>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-database mr-2 text-portal-500"></i>2. Welke gegevens verwerken wij</h2>
          <p>Wij verwerken de volgende persoonsgegevens:</p>
          <ul class="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Identificatiegegevens:</strong> Voornaam, achternaam, e-mailadres, geslacht, geboortedatum</li>
            <li><strong>Gezondheidsgegevens:</strong> Antwoorden op de gezondheidsvragenlijst, laboratoriumuitslagen (indien geüpload), supplementprotocollen</li>
            <li><strong>Technische gegevens:</strong> IP-adres (voor beveiligingsdoeleinden), tijdstip van registratie en toestemming</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-bullseye mr-2 text-portal-500"></i>3. Doel van de verwerking</h2>
          <p>Wij verwerken uw gegevens voor de volgende doelen:</p>
          <ul class="list-disc pl-6 space-y-1 mt-2">
            <li>Het uitvoeren van een persoonlijke gezondheidsanalyse op basis van orthomoleculaire en functionele geneeskunde principes</li>
            <li>Het genereren van gerichte aanbevelingen voor laboratoriumonderzoek</li>
            <li>Het opstellen van persoonlijke supplementprotocollen (na beoordeling door de therapeut)</li>
            <li>Het bijhouden van uw voortgang en gezondheidshistorie</li>
            <li>Communicatie over uw analyse en resultaten</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-balance-scale mr-2 text-portal-500"></i>4. Rechtsgrondslag</h2>
          <p>De verwerking van uw persoonsgegevens is gebaseerd op:</p>
          <ul class="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Uitdrukkelijke toestemming (Art. 6 lid 1a en Art. 9 lid 2a AVG):</strong> U geeft actief toestemming bij registratie door het aanvinken van de toestemmingsverklaringen</li>
            <li><strong>Gerechtvaardigd belang (Art. 6 lid 1f AVG):</strong> Voor beveiligingsmaatregelen zoals rate-limiting en sessiemanagement</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-clock mr-2 text-portal-500"></i>5. Bewaartermijn</h2>
          <p>Wij bewaren uw gegevens zolang als nodig is voor de doeleinden waarvoor zij zijn verzameld. Specifiek:</p>
          <ul class="list-disc pl-6 space-y-1 mt-2">
            <li>Accountgegevens: zolang uw account actief is</li>
            <li>Gezondheidsgegevens: maximaal 20 jaar na laatste contact (conform WGBO)</li>
            <li>Toestemmingsregistratie: 5 jaar na intrekking van toestemming</li>
          </ul>
          <p class="mt-2">U kunt op elk moment verzoeken uw gegevens te laten verwijderen (zie sectie 7).</p>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-lock mr-2 text-portal-500"></i>6. Beveiliging</h2>
          <p>Wij nemen de bescherming van uw gegevens serieus en nemen passende maatregelen:</p>
          <ul class="list-disc pl-6 space-y-1 mt-2">
            <li>Versleutelde verbinding (HTTPS/TLS) voor alle datatransmissie</li>
            <li>Gegevens worden opgeslagen bij Supabase (EU-regio) met versleuteling in rust</li>
            <li>Toegang tot het admin-panel is beveiligd met wachtwoord, tweefactorauthenticatie (2FA) en rate-limiting</li>
            <li>Patiëntgegevens zijn alleen toegankelijk voor de behandelend therapeut</li>
            <li>Sessies verlopen automatisch na 24 uur</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-user-shield mr-2 text-portal-500"></i>7. Uw rechten</h2>
          <p>Op grond van de AVG heeft u de volgende rechten:</p>
          <ul class="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Recht op inzage:</strong> U kunt opvragen welke gegevens wij van u verwerken</li>
            <li><strong>Recht op rectificatie:</strong> U kunt onjuiste gegevens laten corrigeren</li>
            <li><strong>Recht op vergetelheid:</strong> U kunt verzoeken uw gegevens te laten verwijderen</li>
            <li><strong>Recht op beperking:</strong> U kunt de verwerking van uw gegevens laten beperken</li>
            <li><strong>Recht op dataportabiliteit:</strong> U kunt uw gegevens in een gestructureerd formaat opvragen</li>
            <li><strong>Recht om toestemming in te trekken:</strong> U kunt uw toestemming op elk moment intrekken</li>
          </ul>
          <p class="mt-2">Om uw rechten uit te oefenen kunt u contact opnemen via info@fysiopraktijkzeist.nl. Wij reageren binnen 30 dagen op uw verzoek.</p>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-share-alt mr-2 text-portal-500"></i>8. Delen met derden</h2>
          <p>Wij delen uw gegevens <strong>niet</strong> met derden, behalve:</p>
          <ul class="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Supabase (verwerker):</strong> voor veilige opslag van gegevens (EU-regio, verwerkersovereenkomst aanwezig)</li>
            <li><strong>Netlify (hosting):</strong> voor het hosten van de applicatie (geen toegang tot patiëntgegevens)</li>
          </ul>
          <p class="mt-2">Wij verkopen uw gegevens nooit aan derden en gebruiken ze niet voor commerciële doeleinden buiten de beschreven doelen.</p>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3"><i class="fas fa-gavel mr-2 text-portal-500"></i>9. Klachten</h2>
          <p>Heeft u een klacht over de verwerking van uw persoonsgegevens? Neem dan contact met ons op. U heeft daarnaast het recht om een klacht in te dienen bij de Autoriteit Persoonsgegevens (AP): <a href="https://autoriteitpersoonsgegevens.nl" target="_blank" class="text-portal-600 underline">autoriteitpersoonsgegevens.nl</a>.</p>
        </section>

      </div>
    </div>
  </main>
</body></html>`)
})

// ALGEMENE VOORWAARDEN PAGINA
app.get('/voorwaarden', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-3xl mx-auto px-4 py-12">
    <div class="bg-white rounded-2xl shadow-lg p-8 md:p-12">
      <div class="mb-8">
        <a href="/" class="text-portal-600 hover:text-portal-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar home</a>
      </div>
      
      <h1 class="text-3xl font-black text-gray-800 mb-2"><i class="fas fa-file-contract text-portal-600 mr-2"></i>Algemene Voorwaarden</h1>
      <p class="text-sm text-gray-400 mb-8">Laatst bijgewerkt: 10 maart 2026</p>

      <div class="prose max-w-none space-y-6 text-gray-700 leading-relaxed">
        
        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">1. Definities</h2>
          <ul class="list-disc pl-6 space-y-1">
            <li><strong>Platform:</strong> De gezondheidsanalyse-applicatie van Fysiopraktijk Zeist, bereikbaar via afvallen.netlify.app</li>
            <li><strong>Gebruiker:</strong> Iedere persoon die zich registreert op en gebruik maakt van het Platform</li>
            <li><strong>Therapeut:</strong> De behandelend therapeut van Fysiopraktijk Zeist</li>
            <li><strong>Analyse:</strong> De op basis van de vragenlijst gegenereerde gezondheidsanalyse</li>
            <li><strong>Dienst:</strong> Het geheel aan diensten aangeboden via het Platform</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">2. Aard van de Dienst</h2>
          <div class="bg-amber-50 border-l-4 border-amber-400 p-4 rounded-r-lg">
            <p class="font-semibold text-amber-800"><i class="fas fa-exclamation-triangle mr-1"></i> Belangrijk</p>
            <p class="text-sm text-amber-700 mt-1">Het Platform biedt een <em>informatieve gezondheidsanalyse</em> op basis van orthomoleculaire en functionele geneeskunde principes. Dit is uitdrukkelijk <strong>geen medisch advies, diagnose of behandeling</strong> en vervangt niet het oordeel van een arts of medisch specialist.</p>
          </div>
          <p class="mt-3">De analyse is bedoeld als aanvullende informatie om inzicht te geven in mogelijke gezondheidspatronen. De resultaten worden beoordeeld door een gekwalificeerd therapeut voordat deze aan de gebruiker worden vrijgegeven.</p>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">3. Registratie en Toegang</h2>
          <ul class="list-disc pl-6 space-y-1">
            <li>Registratie is gratis en open voor iedereen</li>
            <li>De gebruiker ontvangt een persoonlijke toegangscode</li>
            <li>De gebruiker is verantwoordelijk voor het geheimhouden van deze code</li>
            <li>De gebruiker garandeert dat de opgegeven gegevens juist en volledig zijn</li>
            <li>De minimale leeftijd voor gebruik is 18 jaar</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">4. Aansprakelijkheid</h2>
          <div class="bg-red-50 border-l-4 border-red-400 p-4 rounded-r-lg">
            <p class="font-semibold text-red-800"><i class="fas fa-exclamation-circle mr-1"></i> Uitsluiting aansprakelijkheid</p>
            <ul class="text-sm text-red-700 mt-2 space-y-1 list-disc pl-4">
              <li>Fysiopraktijk Zeist en de betrokken therapeuten zijn <strong>niet aansprakelijk</strong> voor enige directe of indirecte schade die voortvloeit uit het gebruik van het Platform, de gegeven analyses, adviezen of aanbevolen supplementen</li>
              <li>De gebruiker is <strong>zelf verantwoordelijk</strong> voor het raadplegen van een arts voordat wijzigingen worden aangebracht in medicatie, voeding of leefstijl</li>
              <li>Bij acute gezondheidsklachten dient de gebruiker <strong>altijd</strong> contact op te nemen met de huisarts of 112 te bellen</li>
            </ul>
          </div>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">5. Supplementen en aanbevelingen</h2>
          <ul class="list-disc pl-6 space-y-1">
            <li>Supplementadviezen zijn <strong>geen medicatie</strong> en vervangen geen medische behandeling</li>
            <li>Bij zwangerschap, borstvoeding of medicijngebruik dient <strong>altijd</strong> eerst een arts te worden geraadpleegd</li>
            <li>De gebruiker neemt supplementen geheel op eigen risico en verantwoordelijkheid</li>
            <li>Fysiopraktijk Zeist is niet aansprakelijk voor bijwerkingen of interacties met medicatie</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">6. Laboratoriumonderzoek</h2>
          <ul class="list-disc pl-6 space-y-1">
            <li>Het Platform kan aanbevelingen doen voor laboratoriumonderzoek</li>
            <li>De gebruiker is zelf verantwoordelijk voor het laten uitvoeren van eventueel onderzoek</li>
            <li>Laboratoriumuitslagen worden geïnterpreteerd vanuit orthomoleculaire referentiewaarden, die <strong>kunnen afwijken</strong> van conventionele medische referentiewaarden</li>
            <li>De interpretatie vervangt niet het oordeel van de aanvragend arts</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">7. Intellectueel eigendom</h2>
          <p>Alle inhoud van het Platform, waaronder teksten, vragenlijsten, algoritmen, analyses en vormgeving, zijn eigendom van Fysiopraktijk Zeist en worden beschermd door intellectuele eigendomsrechten. Gebruik buiten het Platform is niet toegestaan zonder schriftelijke toestemming.</p>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">8. Beëindiging</h2>
          <ul class="list-disc pl-6 space-y-1">
            <li>De gebruiker kan op elk moment zijn/haar account laten verwijderen door contact op te nemen via info@fysiopraktijkzeist.nl</li>
            <li>Fysiopraktijk Zeist behoudt zich het recht voor om accounts te blokkeren bij misbruik</li>
            <li>Bij beëindiging worden gegevens verwijderd conform het privacybeleid</li>
          </ul>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">9. Wijzigingen</h2>
          <p>Fysiopraktijk Zeist behoudt zich het recht voor deze voorwaarden te wijzigen. Wijzigingen worden op het Platform gepubliceerd. Door het Platform te blijven gebruiken na een wijziging, accepteert de gebruiker de gewijzigde voorwaarden.</p>
        </section>

        <section>
          <h2 class="text-xl font-bold text-gray-800 mb-3">10. Toepasselijk recht</h2>
          <p>Op deze voorwaarden is Nederlands recht van toepassing. Geschillen worden voorgelegd aan de bevoegde rechter in het arrondissement Midden-Nederland.</p>
        </section>

        <section class="border-t pt-6">
          <h2 class="text-xl font-bold text-gray-800 mb-3">Contact</h2>
          <p>Voor vragen over deze voorwaarden kunt u contact opnemen met:</p>
          <div class="bg-gray-50 rounded-lg p-4 mt-3">
            <p class="text-sm"><strong>Fysiopraktijk Zeist</strong><br>
            E-mail: info@fysiopraktijkzeist.nl<br>
            Website: fysiopraktijkzeist.nl</p>
          </div>
        </section>
      </div>
    </div>
  </main>
</body></html>`)
})

// INLOG PAGINA
app.get('/inloggen', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-md mx-auto px-4 py-16">
    <div class="bg-white rounded-2xl shadow-lg p-8 fade-in">
      <div class="text-center mb-8">
        <div class="w-20 h-20 bg-portal-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-key text-portal-600 text-3xl"></i>
        </div>
        <h2 class="text-2xl font-black text-gray-800">Inloggen</h2>
        <p class="text-gray-500 mt-2">Voer uw persoonlijke toegangscode in die u van uw therapeut heeft ontvangen.</p>
      </div>
      
      <form id="login-form" class="space-y-6">
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-2">Toegangscode</label>
          <input 
            id="code-input"
            type="text" 
            maxlength="8" 
            placeholder="Bijv. AB3CDE7F"
            class="w-full border-2 border-gray-200 rounded-xl px-5 py-4 text-center text-2xl font-mono tracking-[0.3em] uppercase focus:ring-2 focus:ring-portal-500 focus:border-portal-500 transition"
            autocomplete="off"
            required
          >
          <p class="text-xs text-gray-400 mt-2 text-center">8 tekens - letters en cijfers</p>
        </div>
        <button type="submit" id="login-btn" class="w-full bg-portal-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-portal-700 transition">
          <i class="fas fa-sign-in-alt mr-2"></i>Inloggen
        </button>
      </form>
      
      <div id="login-error" class="hidden mt-4 bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-sm"></div>
      
      <div class="mt-6 pt-6 border-t text-center space-y-3">
        <div>
          <a href="/code-vergeten" class="text-sm text-amber-600 font-semibold hover:text-amber-700 inline-block"><i class="fas fa-question-circle mr-1"></i>Code vergeten?</a>
        </div>
        <div>
          <p class="text-sm text-gray-400">Nog geen toegangscode?</p>
          <a href="/aanmelden" class="text-sm text-portal-600 font-semibold hover:text-portal-700 mt-1 inline-block"><i class="fas fa-user-plus mr-1"></i>Gratis aanmelden</a>
        </div>
      </div>
    </div>
  </main>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = document.getElementById('code-input').value.trim();
      const btn = document.getElementById('login-btn');
      const errDiv = document.getElementById('login-error');
      
      if (code.length < 6) {
        errDiv.textContent = 'Voer een geldige toegangscode in (minimaal 6 tekens).';
        errDiv.classList.remove('hidden');
        return;
      }
      
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Controleren...';
      errDiv.classList.add('hidden');
      
      try {
        const res = await fetch('/api/portal/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        
        if (res.ok) {
          // Store in sessionStorage
          sessionStorage.setItem('portal_code', code.toUpperCase());
          sessionStorage.setItem('portal_patient', JSON.stringify(data));
          window.location.href = '/menu';
        } else {
          errDiv.textContent = data.error || 'Ongeldige toegangscode. Controleer de code en probeer opnieuw.';
          errDiv.classList.remove('hidden');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Inloggen';
        }
      } catch(err) {
        errDiv.textContent = 'Verbindingsfout. Probeer het later opnieuw.';
        errDiv.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Inloggen';
      }
    });
  </script>
</body></html>`)
})

// CODE VERGETEN PAGINA
app.get('/code-vergeten', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-md mx-auto px-4 py-16">
    <div class="bg-white rounded-2xl shadow-lg p-8 fade-in">
      <div class="text-center mb-8">
        <div class="w-20 h-20 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-envelope-open-text text-amber-600 text-3xl"></i>
        </div>
        <h2 class="text-2xl font-black text-gray-800">Code vergeten?</h2>
        <p class="text-gray-500 mt-2">Geen probleem! Vul het e-mailadres in waarmee u zich heeft aangemeld en we tonen uw toegangscode.</p>
      </div>
      
      <!-- Stap 1: Email invoeren -->
      <div id="step-email">
        <form id="forgot-form" class="space-y-6">
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-2"><i class="fas fa-envelope mr-1 text-gray-400"></i>Uw e-mailadres</label>
            <input 
              id="email-input"
              type="email" 
              placeholder="uw.naam@voorbeeld.nl"
              class="w-full border-2 border-gray-200 rounded-xl px-5 py-4 text-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition"
              autocomplete="email"
              required
            >
          </div>
          <button type="submit" id="forgot-btn" class="w-full bg-amber-500 text-white py-4 rounded-xl font-bold text-lg hover:bg-amber-600 transition">
            <i class="fas fa-search mr-2"></i>Code opzoeken
          </button>
        </form>
        <div id="forgot-error" class="hidden mt-4 bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-sm"></div>
      </div>

      <!-- Stap 2: Code tonen -->
      <div id="step-result" class="hidden">
        <div class="bg-green-50 border-2 border-green-200 rounded-2xl p-6 text-center mb-6">
          <i class="fas fa-check-circle text-green-500 text-4xl mb-3"></i>
          <p class="text-green-800 font-semibold mb-1" id="result-greeting"></p>
          <p class="text-green-700 text-sm mb-4">Hier is uw persoonlijke toegangscode:</p>
          <div class="bg-white rounded-xl p-6 border-2 border-green-300 shadow-sm">
            <p id="result-code" class="text-4xl font-mono font-black tracking-[0.3em] text-gray-800"></p>
          </div>
          <p class="text-xs text-green-600 mt-3"><i class="fas fa-lock mr-1"></i>Bewaar deze code goed — u heeft hem nodig om in te loggen.</p>
        </div>
        <a href="/inloggen" class="block w-full bg-portal-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-portal-700 transition text-center">
          <i class="fas fa-sign-in-alt mr-2"></i>Nu inloggen
        </a>
      </div>

      <!-- Niet gevonden -->
      <div id="step-notfound" class="hidden">
        <div class="bg-amber-50 border-2 border-amber-200 rounded-2xl p-6 text-center mb-6">
          <i class="fas fa-info-circle text-amber-500 text-4xl mb-3"></i>
          <p class="text-amber-800 font-semibold mb-2">Geen account gevonden</p>
          <p class="text-amber-700 text-sm">We konden geen account vinden met dit e-mailadres. Mogelijk heeft u zich met een ander adres aangemeld.</p>
        </div>
        <div class="space-y-3">
          <button onclick="document.getElementById('step-notfound').classList.add('hidden'); document.getElementById('step-email').classList.remove('hidden');" class="block w-full bg-amber-500 text-white py-3 rounded-xl font-bold hover:bg-amber-600 transition text-center">
            <i class="fas fa-redo mr-2"></i>Ander e-mailadres proberen
          </button>
          <a href="/aanmelden" class="block w-full bg-portal-600 text-white py-3 rounded-xl font-bold hover:bg-portal-700 transition text-center">
            <i class="fas fa-user-plus mr-2"></i>Nieuw account aanmaken
          </a>
        </div>
      </div>
      
      <div class="mt-6 pt-6 border-t text-center">
        <a href="/inloggen" class="text-sm text-gray-400 hover:text-gray-600"><i class="fas fa-arrow-left mr-1"></i>Terug naar inloggen</a>
      </div>
    </div>
  </main>
  <script>
    document.getElementById('forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email-input').value.trim();
      const btn = document.getElementById('forgot-btn');
      const errDiv = document.getElementById('forgot-error');
      
      if (!email) {
        errDiv.textContent = 'Vul uw e-mailadres in.';
        errDiv.classList.remove('hidden');
        return;
      }
      
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Zoeken...';
      errDiv.classList.add('hidden');
      
      try {
        const res = await fetch('/api/portal/forgot-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        
        if (data.found) {
          // Code gevonden — toon resultaat
          document.getElementById('result-greeting').textContent = 'Welkom terug, ' + data.first_name + '!';
          document.getElementById('result-code').textContent = data.code;
          document.getElementById('step-email').classList.add('hidden');
          document.getElementById('step-result').classList.remove('hidden');
        } else {
          // Niet gevonden
          document.getElementById('step-email').classList.add('hidden');
          document.getElementById('step-notfound').classList.remove('hidden');
        }
      } catch(err) {
        errDiv.textContent = 'Verbindingsfout. Probeer het later opnieuw.';
        errDiv.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search mr-2"></i>Code opzoeken';
      }
    });
  </script>
</body></html>`)
})

// BETAALPAGINA - Analyse (€9,95)
app.get('/betalen/analyse', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-lg mx-auto px-4 py-12">
    <div class="bg-white rounded-2xl shadow-lg overflow-hidden fade-in">
      <div class="bg-gradient-to-r from-portal-600 to-blue-600 text-white p-8 text-center">
        <div class="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-microscope text-3xl"></i>
        </div>
        <h1 class="text-2xl font-black">Persoonlijke Analyse</h1>
        <p class="opacity-90 mt-2">Op basis van jouw unieke antwoorden</p>
      </div>

      <div class="p-8">
        <div class="space-y-4 mb-8">
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Persoonlijke categorisatie</p>
              <p class="text-sm text-gray-500">Inzicht in jouw specifieke stofwisselingstype</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Beoordeling door therapeut</p>
              <p class="text-sm text-gray-500">Marc beoordeelt jouw resultaten persoonlijk</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Lab-onderzoek aanbeveling</p>
              <p class="text-sm text-gray-500">Gerichte bloedwaarden om te laten onderzoeken</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Eerste advies</p>
              <p class="text-sm text-gray-500">Direct toepasbare tips voor jouw situatie</p>
            </div>
          </div>
        </div>

        <div class="bg-portal-50 rounded-2xl p-6 text-center mb-6">
          <p class="text-sm text-portal-600 font-semibold mb-1">Eenmalig bedrag</p>
          <div class="flex items-baseline justify-center gap-1">
            <span class="text-sm text-gray-500">€</span>
            <span class="text-5xl font-black text-gray-800">9</span>
            <span class="text-2xl font-bold text-gray-800">,95</span>
          </div>
          <p class="text-xs text-gray-400 mt-2">Betaal veilig met iDEAL of creditcard</p>
        </div>

        <button id="pay-btn" onclick="startPayment()" class="w-full bg-portal-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-portal-700 transition shadow-lg shadow-portal-200">
          <i class="fas fa-lock mr-2"></i>Afrekenen — €9,95
        </button>

        <div class="flex items-center justify-center gap-6 mt-6 opacity-60">
          <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/IDEAL_Logo.svg/64px-IDEAL_Logo.svg.png" alt="iDEAL" class="h-6">
          <i class="fab fa-cc-visa text-2xl text-gray-400"></i>
          <i class="fab fa-cc-mastercard text-2xl text-gray-400"></i>
          <i class="fas fa-shield-alt text-xl text-gray-400"></i>
        </div>

        <p class="text-xs text-center text-gray-400 mt-4">
          <i class="fas fa-lock mr-1"></i>Beveiligde betaling via Stripe. Je gegevens zijn veilig.
        </p>
      </div>
    </div>

    <div class="text-center mt-6">
      <a href="/menu" class="text-sm text-gray-400 hover:text-gray-600"><i class="fas fa-arrow-left mr-1"></i>Terug naar menu</a>
    </div>
  </main>

  <script>
    const portalCode = sessionStorage.getItem('portal_code');
    const patientInfo = JSON.parse(sessionStorage.getItem('portal_patient') || '{}');
    if (!portalCode || !patientInfo.id) { window.location.href = '/inloggen'; }

    async function startPayment() {
      const btn = document.getElementById('pay-btn');
      if (!patientInfo.id) {
        alert('Sessie verlopen. Log opnieuw in.');
        window.location.href = '/inloggen';
        return;
      }
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Moment geduld...';

      try {
        const res = await fetch('/api/payments/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patient_id: patientInfo.id,
            payment_type: 'analysis',
            portal_code: portalCode
          })
        });
        const data = await res.json();
        if (data.checkout_url) {
          window.location.href = data.checkout_url;
        } else {
          alert(data.error || 'Er ging iets mis. Probeer opnieuw.');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Afrekenen — €9,95';
        }
      } catch(err) {
        alert('Verbindingsfout. Probeer opnieuw.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Afrekenen — €9,95';
      }
    }
  </script>
</body></html>`)
})

// BETAALPAGINA - Protocol (slider €4,95 — €29,95)
app.get('/betalen/protocol', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-lg mx-auto px-4 py-12">
    <div class="bg-white rounded-2xl shadow-lg overflow-hidden fade-in">
      <div class="bg-gradient-to-r from-emerald-500 to-teal-600 text-white p-8 text-center">
        <div class="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-clipboard-list text-3xl"></i>
        </div>
        <h1 class="text-2xl font-black">Jouw Persoonlijke Protocol</h1>
        <p class="opacity-90 mt-2">Op maat gemaakt door je therapeut</p>
      </div>

      <div class="p-8">
        <div class="space-y-4 mb-8">
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Persoonlijk supplementschema</p>
              <p class="text-sm text-gray-500">Afgestemd op jouw labwaarden en klachten</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Voedingsadvies op maat</p>
              <p class="text-sm text-gray-500">Specifiek voor jouw stofwisselingstype</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Leefstijlaanpassingen</p>
              <p class="text-sm text-gray-500">Slaap, stress, beweging — op jou afgestemd</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-check text-green-600 text-sm"></i>
            </div>
            <div>
              <p class="font-semibold text-gray-800">Follow-up moment</p>
              <p class="text-sm text-gray-500">Evaluatie van jouw voortgang</p>
            </div>
          </div>
        </div>

        <!-- SLIDER -->
        <div class="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl p-6 mb-6">
          <p class="text-sm font-bold text-gray-700 text-center mb-2">Kies wat je kunt missen</p>
          <p class="text-xs text-gray-400 text-center mb-6">Iedereen verdient toegang tot goede gezondheid</p>
          
          <div class="text-center mb-4">
            <div class="flex items-baseline justify-center gap-1">
              <span class="text-sm text-gray-500">€</span>
              <span id="slider-amount" class="text-5xl font-black text-gray-800">14</span>
              <span id="slider-cents" class="text-2xl font-bold text-gray-800">,95</span>
            </div>
          </div>

          <div class="relative px-2">
            <input type="range" id="price-slider" min="495" max="2995" value="1495" step="100"
              class="w-full h-3 bg-gray-200 rounded-full appearance-none cursor-pointer accent-emerald-600"
              oninput="updateSlider(this.value)"
              style="background: linear-gradient(to right, #10b981 0%, #10b981 50%, #e5e7eb 50%, #e5e7eb 100%);">
          </div>

          <div class="flex justify-between mt-2 text-xs">
            <span class="text-gray-400 font-medium">€4,95</span>
            <span class="text-emerald-600 font-semibold" id="slider-label">💚 Gemiddeld</span>
            <span class="text-gray-400 font-medium">€29,95</span>
          </div>

          <div id="slider-message" class="mt-4 text-center text-sm text-gray-500">
            <i class="fas fa-heart text-emerald-500 mr-1"></i>
            Gemiddeld kiezen mensen €14,95
          </div>
        </div>

        <button id="pay-btn" onclick="startProtocolPayment()" class="w-full bg-emerald-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-emerald-700 transition shadow-lg shadow-emerald-200">
          <i class="fas fa-lock mr-2"></i>Afrekenen — <span id="btn-amount">€14,95</span>
        </button>

        <div class="flex items-center justify-center gap-6 mt-6 opacity-60">
          <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/IDEAL_Logo.svg/64px-IDEAL_Logo.svg.png" alt="iDEAL" class="h-6">
          <i class="fab fa-cc-visa text-2xl text-gray-400"></i>
          <i class="fab fa-cc-mastercard text-2xl text-gray-400"></i>
          <i class="fas fa-shield-alt text-xl text-gray-400"></i>
        </div>

        <p class="text-xs text-center text-gray-400 mt-4">
          <i class="fas fa-lock mr-1"></i>Beveiligde betaling via Stripe. Je gegevens zijn veilig.
        </p>
      </div>
    </div>

    <div class="text-center mt-6">
      <a href="/menu" class="text-sm text-gray-400 hover:text-gray-600"><i class="fas fa-arrow-left mr-1"></i>Terug naar menu</a>
    </div>
  </main>

  <script>
    const portalCode = sessionStorage.getItem('portal_code');
    const patientInfo = JSON.parse(sessionStorage.getItem('portal_patient') || '{}');
    if (!portalCode || !patientInfo.id) { window.location.href = '/inloggen'; }

    function updateSlider(val) {
      const euros = Math.floor(val / 100);
      const cents = (val % 100).toString().padStart(2, '0');
      document.getElementById('slider-amount').textContent = euros;
      document.getElementById('slider-cents').textContent = ',' + cents;
      document.getElementById('btn-amount').textContent = '€' + euros + ',' + cents;
      
      // Update slider achtergrondkleur
      const pct = ((val - 495) / (2995 - 495)) * 100;
      document.getElementById('price-slider').style.background = 
        'linear-gradient(to right, #10b981 0%, #10b981 ' + pct + '%, #e5e7eb ' + pct + '%, #e5e7eb 100%)';
      
      // Update label
      const label = document.getElementById('slider-label');
      const msg = document.getElementById('slider-message');
      if (val <= 795) {
        label.textContent = '🤝 Krap budget';
        msg.innerHTML = '<i class="fas fa-heart text-emerald-500 mr-1"></i>Geen probleem — je gezondheid is het belangrijkst';
      } else if (val <= 1295) {
        label.textContent = '👍 Bewuste keuze';
        msg.innerHTML = '<i class="fas fa-heart text-emerald-500 mr-1"></i>Een mooie bijdrage, dankjewel!';
      } else if (val <= 1995) {
        label.textContent = '💚 Gemiddeld';
        msg.innerHTML = '<i class="fas fa-heart text-emerald-500 mr-1"></i>Gemiddeld kiezen mensen €14,95';
      } else {
        label.textContent = '🙏 Royaal';
        msg.innerHTML = '<i class="fas fa-heart text-emerald-500 mr-1"></i>Geweldig! Hiermee help je ook anderen met een krap budget';
      }
    }

    async function startProtocolPayment() {
      const btn = document.getElementById('pay-btn');
      const amount = document.getElementById('price-slider').value;
      if (!patientInfo.id) {
        alert('Sessie verlopen. Log opnieuw in.');
        window.location.href = '/inloggen';
        return;
      }
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Moment geduld...';

      try {
        const res = await fetch('/api/payments/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patient_id: patientInfo.id,
            payment_type: 'protocol',
            amount: amount,
            portal_code: portalCode
          })
        });
        const data = await res.json();
        if (data.checkout_url) {
          window.location.href = data.checkout_url;
        } else {
          alert(data.error || 'Er ging iets mis. Probeer opnieuw.');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Afrekenen — <span id="btn-amount">' + document.getElementById('btn-amount').textContent + '</span>';
        }
      } catch(err) {
        alert('Verbindingsfout. Probeer opnieuw.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Afrekenen — ' + document.getElementById('btn-amount').textContent;
      }
    }
  </script>
</body></html>`)
})

// BETALING SUCCES PAGINA
app.get('/betaling-succes', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-lg mx-auto px-4 py-12">
    <div id="loading" class="text-center py-16">
      <i class="fas fa-spinner fa-spin text-4xl text-portal-600 mb-4"></i>
      <p class="text-gray-500">Betaling verifiëren...</p>
    </div>
    <div id="success" class="hidden fade-in">
      <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
        <div class="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <i class="fas fa-check-circle text-green-500 text-4xl"></i>
        </div>
        <h1 class="text-2xl font-black text-gray-800 mb-2">Betaling geslaagd!</h1>
        <p id="success-message" class="text-gray-500 mb-6">Je betaling is succesvol verwerkt.</p>

        <div id="analysis-next" class="hidden">
          <div class="bg-blue-50 rounded-xl p-5 mb-6 text-left">
            <p class="font-bold text-blue-800 mb-2"><i class="fas fa-info-circle mr-1"></i> Wat gebeurt er nu?</p>
            <ul class="text-sm text-blue-700 space-y-2">
              <li><i class="fas fa-check mr-2 text-blue-400"></i>Je analyse wordt beoordeeld door Marc</li>
              <li><i class="fas fa-check mr-2 text-blue-400"></i>Je ontvangt inzicht in je stofwisselingstype</li>
              <li><i class="fas fa-check mr-2 text-blue-400"></i>Je krijgt een gerichte lab-aanbeveling</li>
              <li><i class="fas fa-clock mr-2 text-blue-400"></i>Verwachte doorlooptijd: 1-2 werkdagen</li>
            </ul>
          </div>
        </div>

        <div id="protocol-next" class="hidden">
          <div class="bg-emerald-50 rounded-xl p-5 mb-6 text-left">
            <p class="font-bold text-emerald-800 mb-2"><i class="fas fa-info-circle mr-1"></i> Wat gebeurt er nu?</p>
            <ul class="text-sm text-emerald-700 space-y-2">
              <li><i class="fas fa-check mr-2 text-emerald-400"></i>Je persoonlijke protocol wordt vrijgegeven</li>
              <li><i class="fas fa-check mr-2 text-emerald-400"></i>Inclusief supplementschema en voedingsadvies</li>
              <li><i class="fas fa-check mr-2 text-emerald-400"></i>Je kunt dit bekijken in je portaal</li>
            </ul>
          </div>
        </div>

        <a href="/menu" class="inline-block bg-portal-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-portal-700 transition">
          <i class="fas fa-arrow-right mr-2"></i>Naar mijn portaal
        </a>
      </div>
    </div>
    <div id="failed" class="hidden fade-in">
      <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
        <div class="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <i class="fas fa-times-circle text-red-500 text-4xl"></i>
        </div>
        <h1 class="text-2xl font-black text-gray-800 mb-2">Betaling niet gelukt</h1>
        <p class="text-gray-500 mb-6">Er is iets misgegaan met je betaling. Probeer het opnieuw.</p>
        <a href="/menu" class="inline-block bg-portal-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-portal-700 transition">
          <i class="fas fa-arrow-left mr-2"></i>Terug naar menu
        </a>
      </div>
    </div>
  </main>

  <script>
    (async function() {
      const params = new URLSearchParams(window.location.search);
      const sessionId = params.get('session_id');
      const type = params.get('type');

      if (!sessionId) {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('failed').classList.remove('hidden');
        return;
      }

      try {
        const res = await fetch('/api/payments/verify/' + sessionId);
        const data = await res.json();

        document.getElementById('loading').classList.add('hidden');

        if (data.paid) {
          document.getElementById('success').classList.remove('hidden');
          if (type === 'analysis') {
            document.getElementById('success-message').textContent = 'Je persoonlijke analyse is betaald. Marc gaat je resultaten beoordelen.';
            document.getElementById('analysis-next').classList.remove('hidden');
          } else if (type === 'protocol') {
            document.getElementById('success-message').textContent = 'Je persoonlijke protocol is betaald. Bedankt voor je bijdrage!';
            document.getElementById('protocol-next').classList.remove('hidden');
          }
          // Update sessionStorage
          const patientInfo = JSON.parse(sessionStorage.getItem('portal_patient') || '{}');
          if (type === 'analysis') patientInfo.analysis_paid = true;
          if (type === 'protocol') patientInfo.protocol_paid = true;
          sessionStorage.setItem('portal_patient', JSON.stringify(patientInfo));
        } else {
          document.getElementById('failed').classList.remove('hidden');
        }
      } catch(err) {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('failed').classList.remove('hidden');
      }
    })();
  </script>
</body></html>`)
})

// PORTAL MENU (na inloggen)
app.get('/menu', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-3xl mx-auto px-4 py-12">
    <div id="menu-container">
      <div class="text-center mb-8 fade-in">
        <div class="w-20 h-20 bg-portal-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-user-circle text-portal-600 text-3xl"></i>
        </div>
        <h2 class="text-2xl font-black text-gray-800">Welkom, <span id="patient-name">...</span></h2>
        <p class="text-gray-500 mt-2" id="menu-subtitle">Kies wat u wilt doen:</p>
      </div>

      <!-- Status banner (dynamisch) -->
      <div id="status-banner" class="hidden mb-6 fade-in"></div>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 fade-in">
        <!-- Stap 1: Vragenlijst (altijd zichtbaar) -->
        <a href="/vragenlijst" id="card-questionnaire" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block">
          <div class="flex items-center justify-between mb-4">
            <div class="w-16 h-16 bg-blue-100 group-hover:bg-blue-200 rounded-2xl flex items-center justify-center transition">
              <i class="fas fa-clipboard-check text-blue-600 text-2xl"></i>
            </div>
            <span id="badge-questionnaire" class="hidden text-xs font-bold px-3 py-1 rounded-full"></span>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Vragenlijst Invullen</h3>
          <p class="text-gray-500 text-sm mb-4">Beantwoord 15 vragen over uw gezondheid. Gratis en vrijblijvend.</p>
          <span class="text-blue-600 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> <span id="cta-questionnaire">Start de vragenlijst</span></span>
        </a>
        
        <!-- Stap 2: Analyse betalen (na vragenlijst) -->
        <div id="card-analysis" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block cursor-pointer hidden" onclick="goToAnalysis()">
          <div class="flex items-center justify-between mb-4">
            <div class="w-16 h-16 bg-portal-100 group-hover:bg-portal-200 rounded-2xl flex items-center justify-center transition">
              <i class="fas fa-microscope text-portal-600 text-2xl"></i>
            </div>
            <span id="badge-analysis" class="text-xs font-bold px-3 py-1 rounded-full bg-portal-100 text-portal-700">€9,95</span>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Persoonlijke Analyse</h3>
          <p class="text-gray-500 text-sm mb-4" id="desc-analysis">Ontvang je volledige analyse, beoordeling door Marc en lab-aanbeveling.</p>
          <span class="text-portal-600 font-semibold text-sm" id="cta-analysis"><i class="fas fa-lock mr-1"></i> Ontgrendel voor €9,95</span>
        </div>

        <!-- Stap 3: Lab Upload (na betaling analyse) -->
        <a href="/lab-upload" id="card-lab" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block hidden">
          <div class="w-16 h-16 bg-amber-100 group-hover:bg-amber-200 rounded-2xl flex items-center justify-center mb-4 transition">
            <i class="fas fa-file-upload text-amber-600 text-2xl"></i>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Lab-formulier Uploaden</h3>
          <p class="text-gray-500 text-sm mb-4">Upload je labresultaten zodat Marc je persoonlijke protocol kan maken.</p>
          <span class="text-amber-600 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> Upload document</span>
        </a>

        <!-- Stap 4: Protocol betalen (nadat lab is verwerkt) -->
        <div id="card-protocol" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block cursor-pointer hidden" onclick="goToProtocol()">
          <div class="flex items-center justify-between mb-4">
            <div class="w-16 h-16 bg-emerald-100 group-hover:bg-emerald-200 rounded-2xl flex items-center justify-center transition">
              <i class="fas fa-clipboard-list text-emerald-600 text-2xl"></i>
            </div>
            <span class="text-xs font-bold px-3 py-1 rounded-full bg-emerald-100 text-emerald-700">vanaf €4,95</span>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Persoonlijk Protocol</h3>
          <p class="text-gray-500 text-sm mb-4">Je supplement- en voedingsschema op maat. Betaal wat je kunt missen.</p>
          <span class="text-emerald-600 font-semibold text-sm"><i class="fas fa-heart mr-1"></i> Kies je bijdrage</span>
        </div>
        
        <!-- Disclaimer -->
        <a href="/#disclaimer" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block">
          <div class="w-16 h-16 bg-yellow-100 group-hover:bg-yellow-200 rounded-2xl flex items-center justify-center mb-4 transition">
            <i class="fas fa-exclamation-triangle text-yellow-600 text-2xl"></i>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Disclaimer & Informatie</h3>
          <p class="text-gray-500 text-sm mb-4">Lees de belangrijke informatie over het gebruik van dit portaal.</p>
          <span class="text-yellow-600 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> Lees meer</span>
        </a>
        
        <!-- Uitloggen -->
        <button onclick="logout()" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group text-left w-full">
          <div class="w-16 h-16 bg-gray-100 group-hover:bg-gray-200 rounded-2xl flex items-center justify-center mb-4 transition">
            <i class="fas fa-sign-out-alt text-gray-500 text-2xl"></i>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Uitloggen</h3>
          <p class="text-gray-500 text-sm mb-4">Sluit uw sessie af.</p>
          <span class="text-gray-500 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> Uitloggen</span>
        </button>
      </div>
    </div>
  </main>
  <script>
    const portalCode = sessionStorage.getItem('portal_code');
    const patientInfo = sessionStorage.getItem('portal_patient');
    if (!portalCode || !patientInfo) {
      window.location.href = '/inloggen';
    }
    const p = JSON.parse(patientInfo);
    document.getElementById('patient-name').textContent = p.first_name + ' ' + p.last_name;

    function goToAnalysis() { window.location.href = '/betalen/analyse'; }
    function goToProtocol() { window.location.href = '/betalen/protocol'; }
    function logout() {
      sessionStorage.removeItem('portal_code');
      sessionStorage.removeItem('portal_patient');
      sessionStorage.removeItem('questionnaire_consent');
      window.location.href = '/';
    }

    // Laad betaalstatus en pas menu aan
    (async function loadMenuState() {
      try {
        const res = await fetch('/api/payments/status/' + p.id);
        const payments = await res.json();
        const analysisPaid = payments.analysis_paid;
        const protocolPaid = payments.protocol_paid;

        // Check of er een assessment is
        const assessRes = await fetch('/api/portal/check-status?code=' + portalCode);
        const assessData = await assessRes.json();
        const hasAssessment = assessData.has_assessment;
        const reviewStatus = assessData.review_status;
        const hasProtocol = assessData.has_protocol;

        const banner = document.getElementById('status-banner');
        const badgeQ = document.getElementById('badge-questionnaire');

        // Vragenlijst badge
        if (hasAssessment) {
          badgeQ.classList.remove('hidden');
          badgeQ.textContent = '✓ Ingevuld';
          badgeQ.className = 'text-xs font-bold px-3 py-1 rounded-full bg-green-100 text-green-700';
          document.getElementById('cta-questionnaire').textContent = 'Bekijk antwoorden';
        }

        // Toon analyse-kaart als vragenlijst is ingevuld
        if (hasAssessment) {
          document.getElementById('card-analysis').classList.remove('hidden');
          if (analysisPaid) {
            document.getElementById('badge-analysis').textContent = '✓ Betaald';
            document.getElementById('badge-analysis').className = 'text-xs font-bold px-3 py-1 rounded-full bg-green-100 text-green-700';
            document.getElementById('cta-analysis').innerHTML = '<i class="fas fa-check mr-1"></i> Betaald';
            document.getElementById('desc-analysis').textContent = reviewStatus === 'reviewed' 
              ? 'Je analyse is beoordeeld! Bekijk je resultaten.'
              : 'Je analyse wordt beoordeeld door Marc. Verwachte doorlooptijd: 1-2 werkdagen.';
          }
        }

        // Toon lab-upload als analyse betaald is
        if (analysisPaid) {
          document.getElementById('card-lab').classList.remove('hidden');
        }

        // Toon protocol-kaart als er een protocol beschikbaar is
        if (hasProtocol && !protocolPaid) {
          document.getElementById('card-protocol').classList.remove('hidden');
        }
        if (protocolPaid) {
          document.getElementById('card-protocol').classList.remove('hidden');
          document.getElementById('card-protocol').innerHTML = '<div class="flex items-center justify-between mb-4"><div class="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center"><i class="fas fa-clipboard-list text-emerald-600 text-2xl"></i></div><span class="text-xs font-bold px-3 py-1 rounded-full bg-green-100 text-green-700">✓ Betaald</span></div><h3 class="text-xl font-bold text-gray-800 mb-2">Persoonlijk Protocol</h3><p class="text-gray-500 text-sm mb-4">Je protocol is beschikbaar.</p><span class="text-emerald-600 font-semibold text-sm"><i class="fas fa-eye mr-1"></i> Bekijk protocol</span>';
        }

        // Status banner
        if (!hasAssessment) {
          banner.innerHTML = '<div class="bg-blue-50 border border-blue-200 rounded-xl p-4"><p class="text-sm text-blue-800"><i class="fas fa-info-circle mr-2"></i><strong>Stap 1:</strong> Vul de gratis vragenlijst in om te beginnen met je persoonlijke analyse.</p></div>';
          banner.classList.remove('hidden');
        } else if (!analysisPaid) {
          banner.innerHTML = '<div class="bg-portal-50 border border-portal-200 rounded-xl p-4"><p class="text-sm text-portal-800"><i class="fas fa-star mr-2"></i><strong>Goed bezig!</strong> Je vragenlijst is ingevuld. Ontgrendel nu je persoonlijke analyse voor €9,95.</p></div>';
          banner.classList.remove('hidden');
        } else if (reviewStatus === 'pending_review') {
          banner.innerHTML = '<div class="bg-amber-50 border border-amber-200 rounded-xl p-4"><p class="text-sm text-amber-800"><i class="fas fa-clock mr-2"></i><strong>In beoordeling:</strong> Marc beoordeelt je analyse. Je ontvangt bericht zodra de resultaten klaar zijn.</p></div>';
          banner.classList.remove('hidden');
        } else if (reviewStatus === 'reviewed' && !protocolPaid && hasProtocol) {
          banner.innerHTML = '<div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4"><p class="text-sm text-emerald-800"><i class="fas fa-gift mr-2"></i><strong>Je protocol is klaar!</strong> Kies je bijdrage en ontvang je persoonlijke supplement- en voedingsschema.</p></div>';
          banner.classList.remove('hidden');
        }

      } catch(err) {
        console.log('Status laden mislukt:', err);
      }
    })();
  </script>
</body></html>`)
})

// PORTAL VRAGENLIJST
app.get('/vragenlijst', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-3xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/menu" class="text-portal-600 hover:text-portal-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar menu</a></div>
    
    <!-- CONSENT SCHERM (vóór de vragenlijst) -->
    <div id="consent-screen" class="bg-white rounded-2xl shadow-lg fade-in">
      <div class="bg-gradient-to-r from-amber-500 to-orange-500 text-white p-6 rounded-t-2xl">
        <h2 class="text-2xl font-bold"><i class="fas fa-file-contract mr-2"></i>Voordat je begint</h2>
        <p class="opacity-90 mt-1">Lees en accepteer onderstaande voorwaarden</p>
      </div>
      <div class="p-6 space-y-5">
        <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p class="text-sm text-blue-800"><i class="fas fa-info-circle mr-2"></i><strong>Over deze vragenlijst:</strong> Je gaat 15 vragen beantwoorden over je gezondheid. Op basis van je antwoorden wordt een analyse gemaakt die door een therapeut wordt beoordeeld. Je resultaten worden pas vrijgegeven na beoordeling.</p>
        </div>

        <div class="space-y-4">
          <label class="flex items-start gap-3 cursor-pointer group">
            <input type="checkbox" id="q-consent-medical" class="mt-1 w-5 h-5 rounded border-gray-300 text-portal-600 focus:ring-portal-500">
            <span class="text-sm text-gray-600 group-hover:text-gray-800 transition"><strong>Medische disclaimer:</strong> Ik begrijp dat deze analyse <em>geen medisch advies, diagnose of behandeling</em> is. De resultaten zijn bedoeld als aanvullende informatie op basis van orthomoleculaire en functionele geneeskunde. Bij acute klachten neem ik contact op met mijn huisarts of bel 112.</span>
          </label>

          <label class="flex items-start gap-3 cursor-pointer group">
            <input type="checkbox" id="q-consent-data" class="mt-1 w-5 h-5 rounded border-gray-300 text-portal-600 focus:ring-portal-500">
            <span class="text-sm text-gray-600 group-hover:text-gray-800 transition"><strong>Gegevensverwerking:</strong> Ik geef toestemming voor het verwerken van mijn gezondheidsantwoorden ten behoeve van de analyse. Mijn gegevens worden veilig opgeslagen conform de <a href="/privacybeleid" target="_blank" class="text-portal-600 underline">AVG/privacybeleid</a>.</span>
          </label>

          <label class="flex items-start gap-3 cursor-pointer group">
            <input type="checkbox" id="q-consent-liability" class="mt-1 w-5 h-5 rounded border-gray-300 text-portal-600 focus:ring-portal-500">
            <span class="text-sm text-gray-600 group-hover:text-gray-800 transition"><strong>Aansprakelijkheid:</strong> Ik begrijp dat Fysiopraktijk Zeist en de betrokken therapeuten niet aansprakelijk zijn voor schade die voortvloeit uit het gebruik van deze analyse of adviezen. Ik ben zelf verantwoordelijk voor mijn gezondheid. Lees onze <a href="/voorwaarden" target="_blank" class="text-portal-600 underline">algemene voorwaarden</a>.</span>
          </label>
        </div>

        <div id="consent-error" class="hidden bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">
          <i class="fas fa-exclamation-circle mr-1"></i> Je moet alle drie de voorwaarden accepteren om door te gaan.
        </div>

        <button onclick="acceptConsent()" class="w-full bg-portal-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-portal-700 transition shadow-lg shadow-portal-200">
          <i class="fas fa-check-circle mr-2"></i>Ik ga akkoord — start de vragenlijst
        </button>
      </div>
    </div>

    <div id="questionnaire-container" class="bg-white rounded-2xl shadow-lg hidden">
      <div class="bg-gradient-to-r from-blue-500 to-cyan-500 text-white p-6 rounded-t-2xl">
        <h2 class="text-2xl font-bold"><i class="fas fa-clipboard-check mr-2"></i>Gezondheids­vragenlijst</h2>
        <p class="opacity-90 mt-1" id="patient-greeting">Laden...</p>
        <p class="text-sm opacity-75">Geschatte tijd: 5-10 minuten | 15 vragen</p>
      </div>
      
      <div class="p-6">
        <div class="mb-6">
          <div class="bg-gray-200 rounded-full h-3"><div id="progress-bar" class="bg-blue-600 h-3 rounded-full progress-bar" style="width:0%"></div></div>
          <p id="progress-text" class="text-xs text-gray-500 mt-1">Vraag 1 van 15</p>
        </div>
        
        <div id="question-container"></div>
        
        <div class="flex justify-between mt-8">
          <button id="btn-prev" onclick="prevQuestion()" class="px-6 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium disabled:opacity-30" disabled>
            <i class="fas fa-arrow-left mr-1"></i> Vorige
          </button>
          <button id="btn-next" onclick="nextQuestion()" class="bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-blue-700">
            Volgende <i class="fas fa-arrow-right ml-1"></i>
          </button>
        </div>
      </div>
    </div>
    
    <!-- Results container (hidden initially) -->
    <div id="results-container" class="hidden"></div>
  </main>
  
  <script>
    // Consent acceptatie functie
    function acceptConsent() {
      const c1 = document.getElementById('q-consent-medical').checked;
      const c2 = document.getElementById('q-consent-data').checked;
      const c3 = document.getElementById('q-consent-liability').checked;
      const errDiv = document.getElementById('consent-error');
      
      if (!c1 || !c2 || !c3) {
        errDiv.classList.remove('hidden');
        return;
      }
      errDiv.classList.add('hidden');
      
      // Sla consent op in sessionStorage
      sessionStorage.setItem('questionnaire_consent', JSON.stringify({
        medical: true, data_processing: true, liability: true,
        timestamp: new Date().toISOString()
      }));
      
      // Verberg consent, toon vragenlijst
      document.getElementById('consent-screen').classList.add('hidden');
      document.getElementById('questionnaire-container').classList.remove('hidden');
    }

    // Check of consent al gegeven is (bij terugkeer)
    const existingConsent = sessionStorage.getItem('questionnaire_consent');
    if (existingConsent) {
      document.getElementById('consent-screen').classList.add('hidden');
      document.getElementById('questionnaire-container').classList.remove('hidden');
    }

    // Check login
    const portalCode = sessionStorage.getItem('portal_code');
    const patientInfo = JSON.parse(sessionStorage.getItem('portal_patient') || '{}');
    if (!portalCode) { window.location.href = '/inloggen'; }
    
    document.getElementById('patient-greeting').textContent = 'Hallo ' + (patientInfo.first_name || '') + ', vul onderstaande vragen eerlijk in.';
    
    let currentQ = 0;
    const answers = {};
    
    // Pre-fill from patient data
    if (patientInfo.gender) answers.gender = patientInfo.gender;
    if (patientInfo.date_of_birth) answers.age = Math.floor((Date.now() - new Date(patientInfo.date_of_birth).getTime()) / 31557600000);
    
    const questions = [
      { id:'gender', text:'Wat is uw geslacht?', type:'choice', options:[{value:'male',label:'Man'},{value:'female',label:'Vrouw'},{value:'other',label:'Anders'}], indicator:'Basis' },
      { id:'age', text:'Wat is uw leeftijd?', type:'number', placeholder:'Bijv. 42', indicator:'Basis' },
      { id:'duration_trying', text:'Hoe lang probeert u al af te vallen?', type:'choice', options:[{value:'less_3_months',label:'Minder dan 3 maanden'},{value:'3_6_months',label:'3-6 maanden'},{value:'6_12_months',label:'6-12 maanden'},{value:'over_1_year',label:'Meer dan 1 jaar'}], indicator:'Metabole weerstand' },
      { id:'weight_loss_success', text:'Valt u af ondanks calorierestrictie en beweging?', type:'choice', options:[{value:'easy',label:'Ja, moeiteloos'},{value:'slow',label:'Langzaam maar wel'},{value:'barely',label:'Nauwelijks / plateau'},{value:'none',label:'Nee, geen resultaat'}], indicator:'Metabole weerstand' },
      { id:'fatigue_cold_dry', text:'Bent u vaak moe, heeft u het vaak koud en heeft u droge huid?', type:'choice', options:[{value:'yes',label:'Ja, regelmatig tot dagelijks'},{value:'sometimes',label:'Soms, maar niet altijd'},{value:'no',label:'Nee, dit herken ik niet'}], indicator:'Schildklier' },
      { id:'menstrual_regularity', text:'Vrouwen: Is uw menstruatiecyclus regelmatig?', type:'choice', options:[{value:'yes',label:'Ja, regelmatig'},{value:'irregular',label:'Onregelmatig'},{value:'no',label:'Nee'},{value:'na',label:'Niet van toepassing'}], indicator:'PCOS/Hormonen' },
      { id:'stress_frequency', text:'Ervaart u regelmatig stress of angst?', type:'choice', options:[{value:'daily',label:'Dagelijks'},{value:'weekly',label:'Wekelijks'},{value:'rarely',label:'Zelden'},{value:'never',label:'Nooit'}], indicator:'Cortisol' },
      { id:'sleep_quality', text:'Hoe is uw slaap?', type:'choice', options:[{value:'excellent',label:'Uitstekend (7-9 uur doorslapen)'},{value:'fair',label:'Redelijk (wordt soms wakker)'},{value:'moderate',label:'Matig (moeite met inslapen)'},{value:'poor',label:'Slecht (< 6 uur of zeer onrustig)'}], indicator:'Cortisol/Leptine' },
      { id:'medication_use', text:'Welke medicijnen gebruikt u?', type:'multi', options:[{value:'none',label:'Geen medicijnen'},{value:'thyroid_med',label:'Schildkliermedicatie'},{value:'statins',label:'Statines (cholesterol)'},{value:'diabetes_med',label:'Diabetesmedicatie'},{value:'antidepressants',label:'Antidepressiva'},{value:'beta_blockers',label:'Bètablokkers'},{value:'other',label:'Anders'}], indicator:'Medicatie' },
      { id:'statin_side_effects', text:'Heeft u last van spierpijn of vermoeidheid bij statinegebruik?', type:'choice', options:[{value:'yes',label:'Ja'},{value:'no',label:'Nee'},{value:'no_statins',label:'Gebruik geen statines'}], indicator:'CoQ10' },
      { id:'hunger_after_meal', text:'Heeft u honger kort na een maaltijd (< 2 uur)?', type:'choice', options:[{value:'always',label:'Altijd'},{value:'often',label:'Vaak'},{value:'sometimes',label:'Soms'},{value:'never',label:'Nooit'}], indicator:'Insuline' },
      { id:'fat_distribution', text:'Waar zit het meeste vet bij u?', type:'choice', options:[{value:'belly',label:'Buik (visceraal)'},{value:'hips_legs',label:'Heupen/benen'},{value:'even',label:'Gelijkmatig verdeeld'},{value:'unsure',label:'Onzeker'}], indicator:'Hormonale distributie' },
      { id:'sugar_cravings', text:'Heeft u sterke cravings voor suiker/zoet?', type:'choice', options:[{value:'daily',label:'Dagelijks'},{value:'regularly',label:'Regelmatig'},{value:'rarely',label:'Zelden'},{value:'never',label:'Nooit'}], indicator:'Insuline/Serotonine' },
      { id:'menopause_status', text:'Bent u in de overgang of postmenopauzaal?', type:'choice', options:[{value:'yes',label:'Ja'},{value:'no',label:'Nee'},{value:'unsure',label:'Weet niet'},{value:'na',label:'Niet van toepassing'}], indicator:'Oestrogeen' },
      { id:'diagnosed_conditions', text:'Heeft u een diagnose van:', type:'multi', options:[{value:'diabetes',label:'Diabetes type 2'},{value:'pcos',label:'PCOS'},{value:'hashimoto',label:'Hashimoto'},{value:'thyroid',label:'Andere schildklieraandoening'},{value:'none',label:'Geen van bovenstaande'}], indicator:'Pathologie' }
    ];
    
    function renderQuestion() {
      const q = questions[currentQ];
      const pct = ((currentQ+1)/questions.length*100).toFixed(0);
      document.getElementById('progress-bar').style.width = pct+'%';
      document.getElementById('progress-text').textContent = 'Vraag '+(currentQ+1)+' van '+questions.length;
      document.getElementById('btn-prev').disabled = currentQ === 0;
      document.getElementById('btn-next').innerHTML = currentQ === questions.length-1 ? '<i class="fas fa-paper-plane mr-1"></i> Versturen' : 'Volgende <i class="fas fa-arrow-right ml-1"></i>';
      
      let html = '<div class="fade-in"><div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-4"><p class="text-xs text-blue-600 font-semibold mb-1"><i class="fas fa-tag mr-1"></i>'+q.indicator+'</p><p class="font-bold text-lg text-gray-800">'+(currentQ+1)+'. '+q.text+'</p></div>';
      
      if (q.type === 'choice') {
        html += '<div class="space-y-2">';
        q.options.forEach(opt => {
          const selected = answers[q.id] === opt.value;
          html += '<label class="block p-4 rounded-xl border-2 cursor-pointer transition '+(selected?'border-blue-500 bg-blue-50':'border-gray-200 hover:border-blue-300')+'"><input type="radio" name="'+q.id+'" value="'+opt.value+'" '+(selected?'checked':'')+' onchange="setAnswer(\\''+q.id+'\\',\\''+opt.value+'\\',\\'choice\\')" class="mr-3"> <span class="font-medium">'+opt.label+'</span></label>';
        });
        html += '</div>';
      } else if (q.type === 'number') {
        html += '<input type="number" value="'+(answers[q.id]||'')+'" oninput="setAnswer(\\''+q.id+'\\',this.value,\\'number\\')" class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="'+q.placeholder+'">';
      } else if (q.type === 'multi') {
        html += '<div class="space-y-2">';
        const selected = answers[q.id] || [];
        q.options.forEach(opt => {
          const isChecked = selected.includes(opt.value);
          html += '<label class="block p-4 rounded-xl border-2 cursor-pointer transition '+(isChecked?'border-blue-500 bg-blue-50':'border-gray-200 hover:border-blue-300')+'"><input type="checkbox" value="'+opt.value+'" '+(isChecked?'checked':'')+' onchange="toggleMulti(\\''+q.id+'\\',\\''+opt.value+'\\',this.checked)" class="mr-3"> <span class="font-medium">'+opt.label+'</span></label>';
        });
        html += '</div>';
      }
      html += '</div>';
      document.getElementById('question-container').innerHTML = html;
    }
    
    function setAnswer(id, value, type) {
      if (type === 'number') answers[id] = parseInt(value) || 0;
      else answers[id] = value;
      renderQuestion();
    }
    
    function toggleMulti(id, value, checked) {
      if (!answers[id]) answers[id] = [];
      if (value === 'none' && checked) { answers[id] = ['none']; }
      else if (checked) { answers[id] = answers[id].filter(v=>v!=='none'); answers[id].push(value); }
      else { answers[id] = answers[id].filter(v => v !== value); }
      renderQuestion();
    }
    
    function nextQuestion() {
      const q = questions[currentQ];
      if (!answers[q.id] || (Array.isArray(answers[q.id]) && !answers[q.id].length)) {
        alert('Beantwoord deze vraag a.u.b.');
        return;
      }
      if (currentQ < questions.length - 1) { currentQ++; renderQuestion(); }
      else { submitPortalAssessment(); }
    }
    
    function prevQuestion() {
      if (currentQ > 0) { currentQ--; renderQuestion(); }
    }
    
    async function submitPortalAssessment() {
      const btn = document.getElementById('btn-next');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Versturen...';
      
      try {
        const res = await fetch('/api/portal/assessment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portal_code: portalCode, responses: answers })
        });
        const result = await res.json();
        
        if (res.ok) {
          showResults(result);
        } else {
          alert('Fout: ' + (result.error || 'Onbekend'));
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i> Versturen';
        }
      } catch(e) {
        alert('Verbindingsfout: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i> Versturen';
      }
    }
    
    function showResults(result) {
      document.getElementById('questionnaire-container').classList.add('hidden');
      const container = document.getElementById('results-container');
      container.classList.remove('hidden');
      
      let html = '<div class="fade-in">';
      
      // Success header
      html += '<div class="bg-gradient-to-r from-portal-500 to-teal-600 text-white p-8 rounded-2xl mb-6 text-center">';
      html += '<i class="fas fa-check-circle text-5xl mb-4 opacity-90"></i>';
      html += '<h2 class="text-3xl font-black mb-2">Vragenlijst Ontvangen!</h2>';
      html += '<p class="opacity-90 text-lg">Uw antwoorden worden beoordeeld door uw therapeut.</p>';
      html += '</div>';

      // Status info
      html += '<div class="bg-amber-50 border-2 border-amber-200 rounded-2xl p-6 mb-6">';
      html += '<div class="flex items-center gap-3 mb-3"><div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center"><i class="fas fa-hourglass-half text-amber-600"></i></div><h3 class="font-bold text-lg text-amber-800">In beoordeling</h3></div>';
      html += '<p class="text-amber-700 text-sm">Uw therapeut analyseert uw antwoorden zorgvuldig. U ontvangt bericht zodra de beoordeling is afgerond en uw persoonlijke plan klaar is.</p>';
      html += '</div>';
      
      // Wat gebeurt er nu?
      html += '<div class="bg-white rounded-2xl shadow-lg p-6 mb-6">';
      html += '<h3 class="font-bold text-xl text-gray-800 mb-4"><i class="fas fa-route mr-2 text-portal-600"></i>Wat gebeurt er nu?</h3>';
      html += '<div class="space-y-4">';
      html += '<div class="flex items-start gap-4"><div class="w-8 h-8 rounded-full bg-portal-100 flex items-center justify-center flex-shrink-0 mt-0.5"><span class="text-portal-700 font-bold text-sm">1</span></div><div><p class="font-semibold text-gray-800">Beoordeling door uw therapeut</p><p class="text-sm text-gray-500">Marc analyseert uw antwoorden en stelt een profiel op</p></div></div>';
      html += '<div class="flex items-start gap-4"><div class="w-8 h-8 rounded-full bg-portal-100 flex items-center justify-center flex-shrink-0 mt-0.5"><span class="text-portal-700 font-bold text-sm">2</span></div><div><p class="font-semibold text-gray-800">Laboratoriumonderzoek</p><p class="text-sm text-gray-500">Op basis van uw profiel worden gerichte bloedwaarden en eventueel ontlastingstesten aanbevolen</p></div></div>';
      html += '<div class="flex items-start gap-4"><div class="w-8 h-8 rounded-full bg-portal-100 flex items-center justify-center flex-shrink-0 mt-0.5"><span class="text-portal-700 font-bold text-sm">3</span></div><div><p class="font-semibold text-gray-800">Persoonlijk plan</p><p class="text-sm text-gray-500">U ontvangt een op maat gemaakt plan met voeding, supplementen en leefstijladvies</p></div></div>';
      html += '</div></div>';
      
      // Uw antwoorden overzicht
      html += '<div class="bg-white rounded-2xl shadow-lg p-6 mb-6">';
      html += '<h3 class="font-bold text-xl text-gray-800 mb-4"><i class="fas fa-clipboard-list mr-2 text-portal-600"></i>Uw Antwoorden</h3>';
      if (result.responses) {
        const questionLabels = {
          gender: "Wat is uw geslacht?",
          age: "Wat is uw leeftijd?",
          duration_trying: "Hoe lang probeert u al af te vallen?",
          weight_loss_success: "Valt u af ondanks calorierestrictie en beweging?",
          fatigue_cold_dry: "Bent u vaak moe, heeft u het vaak koud en heeft u droge huid?",
          menstrual_regularity: "Is uw menstruatiecyclus regelmatig?",
          stress_frequency: "Ervaart u regelmatig stress of angst?",
          sleep_quality: "Hoe is uw slaap?",
          medication_use: "Welke medicijnen gebruikt u?",
          statin_side_effects: "Heeft u last van spierpijn of vermoeidheid bij statinegebruik?",
          hunger_after_meal: "Heeft u honger kort na een maaltijd (< 2 uur)?",
          fat_distribution: "Waar zit het meeste vet bij u?",
          sugar_cravings: "Heeft u sterke trek in suiker/zoet?",
          menopause_status: "Bent u in de overgang of postmenopauzaal?",
          diagnosed_conditions: "Heeft u een diagnose van:"
        };
        const answerLabels = {
          male: "Man", female: "Vrouw", other: "Anders",
          less_3_months: "Minder dan 3 maanden", "3_6_months": "3-6 maanden", "6_12_months": "6-12 maanden", over_1_year: "Meer dan 1 jaar",
          easy: "Ja, moeiteloos", slow: "Langzaam maar wel", barely: "Nauwelijks / plateau", none: "Nee, geen resultaat",
          yes: "Ja", sometimes: "Soms", no: "Nee", na: "Niet van toepassing",
          irregular: "Onregelmatig",
          daily: "Dagelijks", weekly: "Wekelijks", rarely: "Zelden", never: "Nooit",
          excellent: "Uitstekend (7-9 uur doorslapen)", fair: "Redelijk (wordt soms wakker)", moderate: "Matig (moeite met inslapen)", poor: "Slecht (< 6 uur of zeer onrustig)",
          thyroid_med: "Schildkliermedicatie", statins: "Statines (cholesterol)", diabetes_med: "Diabetesmedicatie", antidepressants: "Antidepressiva", beta_blockers: "Bètablokkers",
          no_statins: "Gebruik geen statines",
          always: "Altijd", often: "Vaak",
          belly: "Buik (visceraal)", hips_legs: "Heupen/benen", even: "Gelijkmatig verdeeld", unsure: "Onzeker",
          regularly: "Regelmatig",
          diabetes: "Diabetes type 2", pcos: "PCOS", hashimoto: "Hashimoto", thyroid: "Andere schildklieraandoening"
        };
        html += '<div class="space-y-3">';
        Object.entries(result.responses).forEach(function(entry) {
          var key = entry[0], value = entry[1];
          var label = questionLabels[key] || key;
          var displayVal;
          if (Array.isArray(value)) {
            displayVal = value.map(function(v) { return answerLabels[v] || v; }).join(", ");
          } else {
            displayVal = answerLabels[value] || value || "-";
          }
          html += '<div class="border-b border-gray-100 pb-3"><p class="text-sm font-semibold text-gray-600">' + label + '</p><p class="text-gray-800 mt-0.5">' + displayVal + '</p></div>';
        });
        html += '</div>';
      }
      html += '</div>';
      
      // Actions
      html += '<div class="flex flex-col sm:flex-row gap-4">';
      html += '<a href="/menu" class="bg-portal-600 text-white px-6 py-3 rounded-xl font-bold text-center hover:bg-portal-700 transition"><i class="fas fa-home mr-2"></i>Terug naar Menu</a>';
      html += '<a href="/lab-upload" class="bg-amber-500 text-white px-6 py-3 rounded-xl font-bold text-center hover:bg-amber-600 transition"><i class="fas fa-file-upload mr-2"></i>Lab-formulier Uploaden</a>';
      html += '</div>';
      
      html += '</div>';
      container.innerHTML = html;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    
    renderQuestion();
  </script>
</body></html>`)
})

// PORTAL LAB UPLOAD
app.get('/lab-upload', (c) => {
  return c.html(`${portalHead}
<body class="bg-gray-50 min-h-screen">
  ${portalNav}
  <main class="max-w-2xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/menu" class="text-portal-600 hover:text-portal-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar menu</a></div>
    
    <div class="bg-white rounded-2xl shadow-lg overflow-hidden fade-in">
      <div class="bg-gradient-to-r from-amber-500 to-orange-500 text-white p-6">
        <h2 class="text-2xl font-bold"><i class="fas fa-file-upload mr-2"></i>Lab-formulier Uploaden</h2>
        <p class="opacity-90 mt-1">Upload een foto of scan van uw labresultaten</p>
      </div>
      
      <div class="p-6">
        <div class="bg-amber-50 border-l-4 border-amber-500 p-4 rounded mb-6">
          <p class="text-sm text-amber-800"><i class="fas fa-info-circle mr-2"></i>
            Upload hier uw labresultaten (bloedonderzoek of ontlastingsonderzoek). 
            Uw therapeut verwerkt de waarden in uw dossier. Ondersteunde formaten: foto's (JPG, PNG) en PDF-bestanden.
          </p>
        </div>
        
        <!-- File Drop Zone -->
        <div id="drop-zone" class="border-2 border-dashed border-gray-300 rounded-2xl p-12 text-center cursor-pointer hover:border-portal-400 hover:bg-portal-50/30 transition mb-6" onclick="document.getElementById('file-input').click()">
          <i class="fas fa-cloud-upload-alt text-5xl text-gray-300 mb-4"></i>
          <p class="text-gray-600 font-semibold mb-2">Klik hier of sleep een bestand</p>
          <p class="text-sm text-gray-400">JPG, PNG of PDF (max 10 MB)</p>
          <input type="file" id="file-input" accept="image/*,.pdf" class="hidden" onchange="fileSelected(this)">
        </div>
        
        <!-- File Preview -->
        <div id="file-preview" class="hidden mb-6">
          <div class="border rounded-xl p-4 flex items-center gap-4 bg-gray-50">
            <div id="preview-icon" class="w-16 h-16 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
              <i class="fas fa-file-image text-blue-600 text-2xl"></i>
            </div>
            <div class="flex-1 min-w-0">
              <p id="file-name" class="font-semibold text-gray-800 truncate">bestand.jpg</p>
              <p id="file-size" class="text-sm text-gray-400">0 KB</p>
            </div>
            <button onclick="removeFile()" class="text-red-400 hover:text-red-600 p-2"><i class="fas fa-times text-lg"></i></button>
          </div>
          <div id="preview-image" class="mt-3 hidden">
            <img id="image-preview" class="max-h-64 rounded-xl border mx-auto" alt="Preview">
          </div>
        </div>
        
        <!-- Notes -->
        <div class="mb-6">
          <label class="block text-sm font-bold text-gray-700 mb-2"><i class="fas fa-comment mr-1"></i>Opmerkingen (optioneel)</label>
          <textarea id="upload-notes" rows="3" class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-portal-500 focus:border-portal-500" placeholder="Bijv. 'Bloedonderzoek van 5 maart, huisarts resultaten' of 'Ontlastingstest via Biovis'"></textarea>
        </div>
        
        <!-- Submit -->
        <button id="upload-btn" onclick="submitUpload()" disabled class="w-full bg-portal-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-portal-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
          <i class="fas fa-paper-plane mr-2"></i>Versturen naar Therapeut
        </button>
        
        <div id="upload-result" class="hidden mt-4"></div>
      </div>
    </div>
  </main>
  
  <script>
    // Check login
    const portalCode = sessionStorage.getItem('portal_code');
    if (!portalCode) { window.location.href = '/inloggen'; }
    
    let selectedFile = null;
    
    // Drag & Drop
    const dropZone = document.getElementById('drop-zone');
    ['dragenter','dragover'].forEach(ev => {
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('border-portal-500','bg-portal-50'); });
    });
    ['dragleave','drop'].forEach(ev => {
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('border-portal-500','bg-portal-50'); });
    });
    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length) handleFile(files[0]);
    });
    
    function fileSelected(input) {
      if (input.files.length) handleFile(input.files[0]);
    }
    
    function handleFile(file) {
      if (file.size > 10 * 1024 * 1024) {
        alert('Bestand is te groot (max 10 MB).');
        return;
      }
      selectedFile = file;
      document.getElementById('file-preview').classList.remove('hidden');
      document.getElementById('drop-zone').classList.add('hidden');
      document.getElementById('file-name').textContent = file.name;
      document.getElementById('file-size').textContent = (file.size / 1024).toFixed(0) + ' KB';
      document.getElementById('upload-btn').disabled = false;
      
      // Preview
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          document.getElementById('image-preview').src = e.target.result;
          document.getElementById('preview-image').classList.remove('hidden');
        };
        reader.readAsDataURL(file);
        document.getElementById('preview-icon').innerHTML = '<i class="fas fa-file-image text-blue-600 text-2xl"></i>';
      } else {
        document.getElementById('preview-icon').innerHTML = '<i class="fas fa-file-pdf text-red-600 text-2xl"></i>';
        document.getElementById('preview-image').classList.add('hidden');
      }
    }
    
    function removeFile() {
      selectedFile = null;
      document.getElementById('file-preview').classList.add('hidden');
      document.getElementById('drop-zone').classList.remove('hidden');
      document.getElementById('preview-image').classList.add('hidden');
      document.getElementById('upload-btn').disabled = true;
      document.getElementById('file-input').value = '';
    }
    
    async function submitUpload() {
      if (!selectedFile) return;
      const btn = document.getElementById('upload-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Versturen...';
      
      const notes = document.getElementById('upload-notes').value.trim();
      
      try {
        // Lees bestand als base64
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(selectedFile);
        });

        const res = await fetch('/api/portal/lab-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            portal_code: portalCode,
            file_name: selectedFile.name,
            file_type: selectedFile.type,
            file_size: selectedFile.size,
            file_data: base64Data,
            notes: notes
          })
        });
        const data = await res.json();
        
        const resultDiv = document.getElementById('upload-result');
        if (res.ok) {
          resultDiv.innerHTML = '<div class="bg-green-50 border border-green-200 rounded-xl p-6 text-center"><i class="fas fa-check-circle text-green-500 text-4xl mb-3"></i><p class="font-bold text-green-800 text-lg mb-2">Succesvol verstuurd!</p><p class="text-green-700 text-sm">' + (data.message || 'Uw document is ontvangen.') + '</p><a href="/menu" class="inline-block mt-4 bg-portal-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-portal-700 transition"><i class="fas fa-home mr-1"></i>Terug naar menu</a></div>';
          resultDiv.classList.remove('hidden');
          document.getElementById('file-preview').classList.add('hidden');
          btn.classList.add('hidden');
        } else {
          resultDiv.innerHTML = '<div class="bg-red-50 border border-red-200 rounded-xl p-4"><p class="text-red-700"><i class="fas fa-exclamation-circle mr-1"></i>' + (data.error || 'Fout bij uploaden') + '</p></div>';
          resultDiv.classList.remove('hidden');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Versturen naar Therapeut';
        }
      } catch(e) {
        alert('Verbindingsfout: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Versturen naar Therapeut';
      }
    }
  </script>
</body></html>`)
})

// =====================================================
// THERAPEUT: Genereer toegangscode knop (toevoegen aan patient profiel)
// =====================================================
app.get('/api/patients/:id/portal-code', async (c) => {
  const db = getSupabase(getEnv(c))
  // Try portal_code column first
  const { data, error } = await db
    .from('patients')
    .select('portal_code, portal_code_created_at, notes')
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 500)
  
  // If no portal_code column, check notes
  let portalCode = data.portal_code
  if (!portalCode && data.notes?.includes('PORTAL_CODE:')) {
    const match = data.notes.match(/PORTAL_CODE:([A-Z0-9]+)/)
    if (match) portalCode = match[1]
  }
  
  return c.json({ portal_code: portalCode, portal_code_created_at: data.portal_code_created_at })
})

export default app
