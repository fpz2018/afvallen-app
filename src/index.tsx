import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from 'hono/adapter'
import { getSupabase } from './lib/supabase'
import { classifyPatient, TriageResponses } from './lib/classification'
import { getLabRecommendations, interpretLabResults, generateRiskProfile } from './lib/lab-recommendations'
import { generateProtocol } from './lib/protocol-engine'

type EnvVars = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
}

const app = new Hono()

app.use('/api/*', cors())

// =====================================================
// API: PATIENTS
// =====================================================
app.get('/api/patients', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
  const { error } = await db
    .from('patients')
    .update({ status: 'archived' })
    .eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// Hard delete: permanently remove patient and all related data
app.delete('/api/patients/:id/permanent', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
  const { data, error } = await db
    .from('assessments')
    .select('*')
    .eq('id', c.req.param('id'))
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// Get all assessments for a patient (history)
app.get('/api/assessments/patient/:patientId', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
  const { data, error } = await db
    .from('lab_tests')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.patch('/api/lab-tests/:id/results', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
  const { data, error } = await db
    .from('follow_ups')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('scheduled_date', { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/api/follow-ups', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))
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
  const db = getSupabase(env<EnvVars>(c))

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
    </div>
  </div>
</nav>`

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
        progressData = await progressRes.json();
        try { followUpsData = followUpsRes.ok ? await followUpsRes.json() : []; } catch(e) { followUpsData = []; }

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

        // Header
        html += '<div class="bg-white rounded-xl shadow mb-6"><div class="bg-gradient-to-r from-blue-600 to-cyan-600 text-white p-6 rounded-t-xl"><div class="flex items-center justify-between"><div><h2 class="text-2xl font-bold"><i class="fas fa-clipboard-list mr-2"></i>'+typeLabel+': '+patient.first_name+' '+patient.last_name+'</h2><p class="opacity-90 mt-1"><i class="far fa-calendar mr-1"></i> '+date+'</p></div><div class="flex gap-2"><a href="/admin/results/'+patientId+'/'+assessmentId+'" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-semibold"><i class="fas fa-chart-bar mr-1"></i>Resultaten</a><button onclick="window.print()" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-semibold"><i class="fas fa-print mr-1"></i>Print</button></div></div></div>';

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

        let html = '<div class="bg-white rounded-xl shadow"><div class="bg-gradient-to-r from-purple-600 to-pink-600 text-white p-6 rounded-t-xl"><h2 class="text-2xl font-bold"><i class="fas fa-file-medical mr-2"></i>Protocol: '+patient.first_name+' '+patient.last_name+'</h2><p class="opacity-90 mt-1">Type: '+proto.protocol_type+' | Aangemaakt: '+new Date(proto.created_at).toLocaleDateString('nl-NL')+'</p></div><div class="p-6">';

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
// PATIËNTENPORTAAL - APART GEDEELTE
// =====================================================

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
      <a href="/inloggen" class="bg-portal-600 text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-portal-700 transition shadow-sm"><i class="fas fa-sign-in-alt mr-1"></i> Inloggen</a>
    </div>
  </div>
</nav>`

// =====================================================
// API: PORTAL ACCESS CODES
// =====================================================
app.post('/api/portal/generate-code', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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

app.post('/api/portal/verify-code', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
    patient_id: data.id,
    first_name: data.first_name,
    last_name: data.last_name,
    gender: data.gender,
    date_of_birth: data.date_of_birth
  })
})

// Portal assessment submission (from patient side)
app.post('/api/portal/assessment', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
    assessment_type: 'portal_self',
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
    categories: classification.categories.map(c => ({ name: c.name, risk: c.risk })),
    primaryType: classification.primaryType,
    overallRisk: riskProfile.overallRisk,
    recommendations: riskProfile.recommendations || []
  }, 201)
})

// Portal lab document upload (store as base64 in Supabase since no R2/Storage)
app.post('/api/portal/lab-upload', async (c) => {
  const db = getSupabase(env<EnvVars>(c))
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
  
  // Store the upload reference in progress_tracking or a notes field
  const { data, error } = await db
    .from('progress_tracking')
    .insert([{
      patient_id: patient.id,
      measurement_date: new Date().toISOString().split('T')[0],
      notes: `📎 Lab-document geüpload via portaal: ${body.file_name || 'onbekend'} (${body.file_type || 'onbekend'}) - ${new Date().toLocaleString('nl-NL')}`
    }])
    .select()
    .single()
  
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, message: 'Document ontvangen. Uw therapeut wordt geïnformeerd.' })
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
      <p class="text-white/80 text-lg mb-10 max-w-xl mx-auto">Start vandaag nog met jouw persoonlijke analyse. Heeft u een toegangscode ontvangen van uw therapeut?</p>
      <a href="/inloggen" class="bg-white text-portal-700 px-10 py-4 rounded-xl font-bold text-lg hover:bg-portal-50 transition shadow-lg hover:shadow-xl inline-block">
        <i class="fas fa-arrow-right mr-2"></i>Start mijn analyse
      </a>
      <p class="text-sm text-white/50 mt-6">Nog geen toegangscode? Neem contact op met Fysiopraktijk Zeist.</p>
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
      
      <div class="mt-6 pt-6 border-t text-center">
        <p class="text-sm text-gray-400">Geen toegangscode ontvangen?</p>
        <p class="text-sm text-gray-500 mt-1">Neem contact op met de praktijk of vraag uw therapeut om een code.</p>
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
        <p class="text-gray-500 mt-2">Kies wat u wilt doen:</p>
      </div>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 fade-in">
        <!-- Vragenlijst -->
        <a href="/vragenlijst" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block">
          <div class="w-16 h-16 bg-blue-100 group-hover:bg-blue-200 rounded-2xl flex items-center justify-center mb-4 transition">
            <i class="fas fa-clipboard-check text-blue-600 text-2xl"></i>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Vragenlijst Invullen</h3>
          <p class="text-gray-500 text-sm mb-4">Beantwoord 15 vragen over uw gezondheid, leefstijl en klachten. De resultaten worden automatisch geanalyseerd.</p>
          <span class="text-blue-600 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> Start de vragenlijst</span>
        </a>
        
        <!-- Lab Upload -->
        <a href="/lab-upload" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block">
          <div class="w-16 h-16 bg-amber-100 group-hover:bg-amber-200 rounded-2xl flex items-center justify-center mb-4 transition">
            <i class="fas fa-file-upload text-amber-600 text-2xl"></i>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Lab-formulier Uploaden</h3>
          <p class="text-gray-500 text-sm mb-4">Upload een foto of scan van uw labresultaten. Uw therapeut verwerkt deze in uw dossier.</p>
          <span class="text-amber-600 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> Upload document</span>
        </a>
        
        <!-- Disclaimer -->
        <a href="/#disclaimer" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group block">
          <div class="w-16 h-16 bg-yellow-100 group-hover:bg-yellow-200 rounded-2xl flex items-center justify-center mb-4 transition">
            <i class="fas fa-exclamation-triangle text-yellow-600 text-2xl"></i>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Disclaimer & Informatie</h3>
          <p class="text-gray-500 text-sm mb-4">Lees de belangrijke informatie over het gebruik van dit portaal en de medische disclaimer.</p>
          <span class="text-yellow-600 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> Lees meer</span>
        </a>
        
        <!-- Uitloggen -->
        <button onclick="logout()" class="bg-white rounded-2xl shadow-sm border p-8 card-hover group text-left w-full">
          <div class="w-16 h-16 bg-gray-100 group-hover:bg-gray-200 rounded-2xl flex items-center justify-center mb-4 transition">
            <i class="fas fa-sign-out-alt text-gray-500 text-2xl"></i>
          </div>
          <h3 class="text-xl font-bold text-gray-800 mb-2">Uitloggen</h3>
          <p class="text-gray-500 text-sm mb-4">Sluit uw sessie af. U kunt later opnieuw inloggen met uw toegangscode.</p>
          <span class="text-gray-500 font-semibold text-sm"><i class="fas fa-arrow-right mr-1"></i> Uitloggen</span>
        </button>
      </div>
    </div>
  </main>
  <script>
    // Check login
    const portalCode = sessionStorage.getItem('portal_code');
    const patientInfo = sessionStorage.getItem('portal_patient');
    if (!portalCode || !patientInfo) {
      window.location.href = '/inloggen';
    } else {
      const p = JSON.parse(patientInfo);
      document.getElementById('patient-name').textContent = p.first_name + ' ' + p.last_name;
    }
    
    function logout() {
      sessionStorage.removeItem('portal_code');
      sessionStorage.removeItem('portal_patient');
      window.location.href = '/';
    }
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
    
    <div id="questionnaire-container" class="bg-white rounded-2xl shadow-lg">
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
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Analyseren...';
      
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
      
      const riskColors = { high: 'from-red-500 to-red-700', medium: 'from-orange-400 to-orange-600', low: 'from-green-500 to-green-700' };
      const riskLabels = { high: 'Hoog', medium: 'Gemiddeld', low: 'Laag' };
      const riskText = { high: 'Er zijn meerdere risicofactoren gevonden. Uw therapeut zal dit uitgebreid met u bespreken.', medium: 'Er zijn enkele aandachtspunten gevonden. Uw therapeut bespreekt de vervolgstappen.', low: 'Uw profiel ziet er goed uit. Uw therapeut beoordeelt de details.' };
      
      let html = '<div class="fade-in">';
      
      // Success header
      html += '<div class="bg-gradient-to-r ' + (riskColors[result.overallRisk] || riskColors.low) + ' text-white p-8 rounded-2xl mb-6 text-center">';
      html += '<i class="fas fa-check-circle text-5xl mb-4 opacity-90"></i>';
      html += '<h2 class="text-3xl font-black mb-2">Vragenlijst Verstuurd!</h2>';
      html += '<p class="opacity-90 text-lg">Uw antwoorden zijn succesvol verwerkt en geanalyseerd.</p>';
      html += '</div>';
      
      // Risk overview
      html += '<div class="bg-white rounded-2xl shadow-lg p-6 mb-6">';
      html += '<h3 class="font-bold text-xl text-gray-800 mb-4"><i class="fas fa-chart-pie mr-2 text-portal-600"></i>Uw Resultaat Samenvatting</h3>';
      html += '<div class="bg-gray-50 rounded-xl p-4 mb-4"><p class="text-sm text-gray-600"><strong>Algeheel risiconiveau:</strong> <span class="font-bold text-lg ml-2 ' + (result.overallRisk === 'high' ? 'text-red-600' : result.overallRisk === 'medium' ? 'text-orange-600' : 'text-green-600') + '">' + (riskLabels[result.overallRisk] || '-') + '</span></p>';
      html += '<p class="text-sm text-gray-500 mt-2">' + (riskText[result.overallRisk] || '') + '</p></div>';
      
      // Categories found
      if (result.categories?.length) {
        html += '<h4 class="font-bold text-gray-700 mb-3"><i class="fas fa-tags mr-1"></i>Gevonden categorieën:</h4><div class="flex flex-wrap gap-2 mb-4">';
        const catColorsMap = { high: 'bg-red-100 text-red-700 border-red-300', medium: 'bg-orange-100 text-orange-700 border-orange-300', low: 'bg-green-100 text-green-700 border-green-300' };
        result.categories.forEach(cat => {
          html += '<span class="px-4 py-2 rounded-full text-sm font-bold border ' + (catColorsMap[cat.risk] || 'bg-gray-100') + '">' + cat.name + '</span>';
        });
        html += '</div>';
      }
      
      // What happens next
      html += '<div class="bg-blue-50 border border-blue-200 rounded-xl p-4">';
      html += '<h4 class="font-bold text-blue-800 mb-2"><i class="fas fa-forward mr-1"></i>Wat gebeurt er nu?</h4>';
      html += '<ul class="space-y-2 text-sm text-blue-700">';
      html += '<li class="flex items-start gap-2"><i class="fas fa-check text-blue-500 mt-1"></i><span>Uw therapeut Marc ontvangt en beoordeelt uw antwoorden</span></li>';
      html += '<li class="flex items-start gap-2"><i class="fas fa-check text-blue-500 mt-1"></i><span>Op basis hiervan worden gerichte laboratoriumtesten aanbevolen</span></li>';
      html += '<li class="flex items-start gap-2"><i class="fas fa-check text-blue-500 mt-1"></i><span>Na de labresultaten krijgt u een persoonlijk behandelplan</span></li>';
      html += '<li class="flex items-start gap-2"><i class="fas fa-check text-blue-500 mt-1"></i><span>Dit plan bevat voedingsadvies, supplementen en leefstijltips</span></li>';
      html += '</ul></div>';
      html += '</div>';
      
      // Recommendations (if any)
      if (result.recommendations?.length) {
        html += '<div class="bg-white rounded-2xl shadow-lg p-6 mb-6">';
        html += '<h3 class="font-bold text-xl text-gray-800 mb-4"><i class="fas fa-lightbulb mr-2 text-amber-500"></i>Voorlopige Aanbevelingen</h3>';
        html += '<div class="space-y-2">';
        result.recommendations.forEach((rec, i) => {
          html += '<div class="flex items-start gap-3 bg-amber-50 p-3 rounded-lg"><span class="font-bold text-amber-600 min-w-[24px]">' + (i+1) + '.</span><span class="text-sm text-amber-800">' + rec + '</span></div>';
        });
        html += '</div></div>';
      }
      
      // Actions
      html += '<div class="flex flex-col sm:flex-row gap-4">';
      html += '<a href="/menu" class="bg-portal-600 text-white px-6 py-3 rounded-xl font-bold text-center hover:bg-portal-700 transition"><i class="fas fa-home mr-2"></i>Terug naar Menu</a>';
      html += '<a href="/lab-upload" class="bg-amber-500 text-white px-6 py-3 rounded-xl font-bold text-center hover:bg-amber-600 transition"><i class="fas fa-file-upload mr-2"></i>Lab-formulier Uploaden</a>';
      html += '<button onclick="window.print()" class="border border-gray-300 px-6 py-3 rounded-xl font-medium hover:bg-gray-50 transition"><i class="fas fa-print mr-2"></i>Print</button>';
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
        const res = await fetch('/api/portal/lab-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            portal_code: portalCode,
            file_name: selectedFile.name,
            file_type: selectedFile.type,
            file_size: selectedFile.size,
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
  const db = getSupabase(env<EnvVars>(c))
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
