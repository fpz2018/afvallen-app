import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getSupabase } from './lib/supabase'
import { classifyPatient, TriageResponses } from './lib/classification'
import { getLabRecommendations, interpretLabResults } from './lib/lab-recommendations'
import { generateProtocol } from './lib/protocol-engine'

type Bindings = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// =====================================================
// API: PATIENTS
// =====================================================
app.get('/api/patients', async (c) => {
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
  const { error } = await db
    .from('patients')
    .update({ status: 'archived' })
    .eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// =====================================================
// API: ASSESSMENTS
// =====================================================
app.post('/api/assessments', async (c) => {
  const db = getSupabase(c.env)
  const body = await c.req.json()

  // Run classification
  const classification = classifyPatient(body.responses as TriageResponses)

  const assessmentData = {
    patient_id: body.patient_id,
    assessment_type: body.assessment_type || 'quick',
    determined_type: classification.primaryType,
    categories: classification.categories,
    risk_scores: classification.riskScores,
    responses: body.responses,
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

  // Generate lab recommendations
  const categoryIds = classification.categories.map(cat => cat.id)
  const labPackage = getLabRecommendations(categoryIds)

  // Store lab test recommendation
  await db
    .from('lab_tests')
    .insert([{
      patient_id: body.patient_id,
      assessment_id: data.id,
      test_package: labPackage.name,
      recommended_tests: labPackage.tests,
      status: 'recommended'
    }])

  return c.json({
    assessment: data,
    classification,
    labRecommendations: labPackage
  }, 201)
})

app.get('/api/assessments/:id', async (c) => {
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
  const { data, error } = await db
    .from('lab_tests')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.patch('/api/lab-tests/:id/results', async (c) => {
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
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
  const db = getSupabase(c.env)
  const { data, error } = await db
    .from('supplement_protocols')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// =====================================================
// API: PROGRESS TRACKING
// =====================================================
app.post('/api/progress', async (c) => {
  const db = getSupabase(c.env)
  const body = await c.req.json()
  const { data, error } = await db
    .from('progress_tracking')
    .insert([body])
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.get('/api/progress/:patientId', async (c) => {
  const db = getSupabase(c.env)
  const { data, error } = await db
    .from('progress_tracking')
    .select('*')
    .eq('patient_id', c.req.param('patientId'))
    .order('measurement_date', { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// =====================================================
// API: DASHBOARD STATS
// =====================================================
app.get('/api/stats', async (c) => {
  const db = getSupabase(c.env)

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
    <a href="/" class="flex items-center gap-3 hover:opacity-90">
      <i class="fas fa-weight text-2xl"></i>
      <div>
        <h1 class="text-lg font-bold leading-tight">Weight Loss Assessment</h1>
        <p class="text-xs opacity-75">Marc's Praktijk</p>
      </div>
    </a>
    <div class="flex items-center gap-4">
      <a href="/" class="px-3 py-2 rounded hover:bg-white/10 text-sm"><i class="fas fa-home mr-1"></i> Dashboard</a>
      <a href="/patients" class="px-3 py-2 rounded hover:bg-white/10 text-sm"><i class="fas fa-users mr-1"></i> Patiënten</a>
      <a href="/new-patient" class="bg-white text-primary-700 px-4 py-2 rounded-lg font-semibold text-sm hover:bg-primary-50"><i class="fas fa-plus mr-1"></i> Nieuwe Patiënt</a>
    </div>
  </div>
</nav>`

// DASHBOARD
app.get('/', (c) => {
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
        <a href="/new-patient" class="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary-700"><i class="fas fa-plus mr-1"></i> Nieuwe Patiënt</a>
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
          list.innerHTML = '<div class="text-center py-12"><i class="fas fa-user-plus text-4xl text-gray-300 mb-4"></i><p class="text-gray-400 mb-4">Nog geen patiënten</p><a href="/new-patient" class="bg-primary-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-primary-700">Voeg eerste patiënt toe</a></div>';
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
            return '<tr class="border-b hover:bg-gray-50"><td class="py-3 font-semibold">' + p.first_name + ' ' + p.last_name + '</td><td class="py-3">' + age + '</td><td class="py-3"><div class="flex flex-wrap gap-1">' + (catTags||'-') + '</div></td><td class="py-3">' + statusBadge + '</td><td class="py-3"><a href="/patient/' + p.id + '" class="text-primary-600 hover:text-primary-800 font-semibold text-sm mr-3"><i class="fas fa-eye mr-1"></i>Bekijk</a>' + (!lastAssessment ? '<a href="/triage/' + p.id + '" class="text-green-600 hover:text-green-800 font-semibold text-sm"><i class="fas fa-clipboard-check mr-1"></i>Start Triage</a>' : '') + '</td></tr>';
          }).join('') + '</tbody></table>';
      } catch(e) {
        console.error(e);
        document.getElementById('patient-list').innerHTML = '<p class="text-red-500 text-center py-8">Fout bij laden. Controleer database verbinding.</p>';
      }
    }
    loadDashboard();
  </script>
</body>
</html>`)
})

// NEW PATIENT PAGE
app.get('/new-patient', (c) => {
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
          window.location.href = '/triage/' + result.id;
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
app.get('/patients', (c) => {
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-7xl mx-auto px-4 py-8">
    <div class="flex justify-between items-center mb-8">
      <div><h2 class="text-2xl font-bold text-gray-800">Patiënten</h2><p class="text-gray-500">Alle actieve patiënten</p></div>
      <a href="/new-patient" class="bg-primary-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-primary-700"><i class="fas fa-plus mr-1"></i> Nieuwe Patiënt</a>
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
          return '<a href="/patient/'+p.id+'" class="block border rounded-xl p-4 hover:shadow-md transition card-hover"><div class="flex items-center justify-between"><div><p class="font-bold text-gray-800">'+p.first_name+' '+p.last_name+'</p><p class="text-sm text-gray-500">'+age+' jaar | '+new Date(p.created_at).toLocaleDateString('nl-NL')+'</p></div><div class="flex flex-wrap gap-1">'+cats+'</div></div></a>';
        }).join('') + '</div>';
      } catch(e) { container.innerHTML = '<p class="text-red-500 text-center">Fout bij laden: '+e.message+'</p>'; }
    }
    loadPatients();
  </script>
</body></html>`)
})

// QUICK TRIAGE PAGE
app.get('/triage/:patientId', (c) => {
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
          window.location.href = '/results/' + patientId + '/' + result.assessment.id;
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

// RESULTS PAGE
app.get('/results/:patientId/:assessmentId', (c) => {
  const patientId = c.req.param('patientId')
  const assessmentId = c.req.param('assessmentId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-4xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
    <div id="results-container"><p class="text-center py-12 text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>Resultaten laden...</p></div>
  </main>
  <script>
    const patientId = '${patientId}';
    const assessmentId = '${assessmentId}';
    const riskColors = {high:'border-red-500 bg-red-50',medium:'border-orange-500 bg-orange-50',low:'border-green-500 bg-green-50'};
    const riskLabels = {high:'HOOG RISICO',medium:'GEMIDDELD RISICO',low:'LAAG RISICO'};
    const riskTextColors = {high:'text-red-700',medium:'text-orange-700',low:'text-green-700'};
    const iconMap = {'fa-fire':'text-red-600','fa-moon':'text-indigo-600','fa-venus':'text-pink-600','fa-brain':'text-orange-600','fa-candy-cane':'text-red-600','fa-pills':'text-blue-600','fa-dumbbell':'text-green-600'};

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
        const hasRedFlags = categories.some(c => c.risk === 'high' || c.risk === 'medium');

        let html = '<div class="bg-white rounded-xl shadow"><div class="bg-gradient-to-r from-green-500 to-teal-500 text-white p-6 rounded-t-xl"><h2 class="text-2xl font-bold"><i class="fas fa-user-check mr-2"></i>Assessment Resultaat: '+patient.first_name+' '+patient.last_name+'</h2><p class="opacity-90 mt-1">Quick Triage voltooid op '+new Date(assessment.created_at).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric'})+'</p></div><div class="p-6">';

        if (hasRedFlags) {
          html += '<div class="bg-yellow-50 border-l-4 border-yellow-500 p-4 mb-6 rounded"><p class="font-bold text-yellow-800"><i class="fas fa-exclamation-triangle mr-2"></i>Rode Vlaggen Gedetecteerd</p><p class="text-sm text-yellow-700 mt-1">Deze patiënt valt in meerdere risico-categorieën. Aanbevolen: uitgebreid lab-onderzoek en gecombineerd protocol.</p></div>';
        }

        html += '<h3 class="font-bold text-lg mb-4">Geïdentificeerde Categorieën:</h3><div class="space-y-3 mb-6">';
        categories.forEach(cat => {
          html += '<div class="border-l-4 p-4 rounded '+riskColors[cat.risk]+'"><p class="font-bold '+riskTextColors[cat.risk]+'"><i class="fas '+cat.icon+' mr-2 '+(iconMap[cat.icon]||'')+'"></i>'+cat.name+' - '+riskLabels[cat.risk]+'</p><ul class="text-sm mt-2 ml-6 list-disc '+riskTextColors[cat.risk]+'">'+cat.triggers.map(t=>'<li>'+t+'</li>').join('')+'</ul></div>';
        });
        html += '</div>';

        // Lab recommendations
        const latestLab = labs[0];
        if (latestLab) {
          const tests = latestLab.recommended_tests || [];
          const required = tests.filter(t=>t.required);
          const optional = tests.filter(t=>!t.required);
          html += '<h3 class="font-bold text-lg mb-4"><i class="fas fa-flask mr-2 text-blue-600"></i>Aanbevolen Lab-Testen</h3><div class="bg-blue-50 p-4 rounded-lg mb-6"><div class="grid grid-cols-1 md:grid-cols-2 gap-4"><div><p class="font-bold text-blue-800 mb-2">Verplicht ('+required.length+'):</p><ul class="text-sm text-blue-700 space-y-1">'+required.map(t=>'<li><i class="fas fa-check mr-1"></i>'+t.name+(t.note?' <span class="text-xs text-blue-500">('+t.note+')</span>':'')+'</li>').join('')+'</ul></div><div><p class="font-bold text-blue-800 mb-2">Optioneel ('+optional.length+'):</p><ul class="text-sm text-blue-600 space-y-1">'+optional.map(t=>'<li><i class="far fa-circle mr-1"></i>'+t.name+(t.note?' <span class="text-xs text-blue-400">('+t.note+')</span>':'')+'</li>').join('')+'</ul></div></div></div>';
        }

        // Action buttons
        html += '<div class="flex flex-wrap gap-3 mt-6"><a href="/patient/'+patientId+'" class="bg-primary-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-primary-700"><i class="fas fa-user mr-2"></i>Patiëntprofiel</a><button onclick="generateProtocol()" class="bg-green-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-green-700"><i class="fas fa-file-medical mr-2"></i>Genereer Protocol</button><button onclick="window.print()" class="border border-gray-300 px-6 py-3 rounded-lg font-medium hover:bg-gray-50"><i class="fas fa-print mr-2"></i>Print</button></div>';
        html += '</div></div>';

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
        if (res.ok) { window.location.href = '/patient/'+patientId; }
        else { const err = await res.json(); alert('Fout: '+(err.error||'Onbekend')); }
      } catch(e) { alert('Fout: '+e.message); }
    }

    loadResults();
  </script>
</body></html>`)
})

// PATIENT PROFILE PAGE
app.get('/patient/:id', (c) => {
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

    async function loadProfile() {
      try {
        const res = await fetch('/api/patients/'+patientId);
        const p = await res.json();
        const age = p.date_of_birth ? Math.floor((Date.now()-new Date(p.date_of_birth).getTime())/31557600000) : '-';
        const genderLabel = {male:'Man',female:'Vrouw',other:'Anders'}[p.gender] || '-';
        const lastAssessment = (p.assessments||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
        const categories = lastAssessment?.categories || [];
        const catTags = categories.map(c=>'<span class="px-3 py-1 rounded-full text-sm font-semibold '+(catColors[c.id]||'bg-gray-100 text-gray-700')+'"><i class="fas '+c.icon+' mr-1"></i>'+(categoryNames[c.id]||c.name)+'</span>').join(' ');

        let html = '';
        // Header
        html += '<div class="bg-white rounded-xl shadow mb-6"><div class="bg-gradient-to-r from-primary-600 to-primary-800 text-white p-6 rounded-t-xl"><div class="flex items-center justify-between"><div><h2 class="text-2xl font-bold">'+p.first_name+' '+p.last_name+'</h2><p class="opacity-90">'+age+' jaar | '+genderLabel+' | '+( p.email||'Geen email')+'</p></div><div class="flex gap-2">'+(lastAssessment?'':'<a href="/triage/'+p.id+'" class="bg-white text-primary-700 px-4 py-2 rounded-lg font-semibold text-sm hover:bg-primary-50"><i class="fas fa-clipboard-check mr-1"></i>Start Triage</a>')+'</div></div></div><div class="p-6"><div class="flex flex-wrap gap-2">'+( catTags||'<span class="text-gray-400">Nog geen assessment</span>')+'</div></div></div>';

        // Assessment Historie
        const assessments = (p.assessments||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        html += '<div class="bg-white rounded-xl shadow mb-6"><div class="p-4 border-b flex items-center justify-between"><h3 class="font-bold text-lg"><i class="fas fa-clipboard-list mr-2 text-blue-600"></i>Assessment Historie ('+assessments.length+')</h3>'+(assessments.length?'<a href="/triage/'+p.id+'" class="bg-blue-600 text-white px-3 py-1 rounded text-sm font-semibold hover:bg-blue-700"><i class="fas fa-plus mr-1"></i>Nieuwe Triage</a>':'')+'</div><div class="p-4">';
        if (!assessments.length) {
          html += '<div class="text-center py-6"><i class="fas fa-clipboard text-4xl text-gray-300 mb-3"></i><p class="text-gray-400 mb-3">Nog geen assessments afgenomen</p><a href="/triage/'+p.id+'" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700"><i class="fas fa-clipboard-check mr-1"></i>Start eerste triage</a></div>';
        } else {
          html += '<div class="space-y-3">';
          assessments.forEach((a, idx) => {
            const aCats = (a.categories||[]);
            const aCatTags = aCats.map(c=>'<span class="px-2 py-0.5 rounded-full text-xs font-semibold '+(catColors[c.id]||'bg-gray-100 text-gray-700')+'">'+(categoryNames[c.id]||c.name)+'</span>').join(' ');
            const riskBadge = aCats.some(c=>c.risk==='high') ? '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">HOOG RISICO</span>' : aCats.some(c=>c.risk==='medium') ? '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">GEMIDDELD</span>' : '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">LAAG</span>';
            const date = new Date(a.created_at).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});
            const typeLabel = {quick:'Quick Triage',standard:'Standard Assessment',deep:'Deep Dive'}[a.assessment_type]||a.assessment_type;
            html += '<a href="/assessment/'+p.id+'/'+a.id+'" class="block border rounded-xl p-4 hover:shadow-md transition card-hover '+(idx===0?'border-blue-200 bg-blue-50/30':'border-gray-200')+'"><div class="flex items-start justify-between"><div class="flex-1"><div class="flex items-center gap-2 mb-1"><span class="font-bold text-gray-800">'+typeLabel+'</span>'+(idx===0?'<span class="px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 font-semibold">Meest Recent</span>':'')+'</div><p class="text-sm text-gray-500 mb-2"><i class="far fa-calendar mr-1"></i>'+date+'</p><div class="flex flex-wrap gap-1">'+aCatTags+'</div></div><div class="flex flex-col items-end gap-2">'+riskBadge+'<span class="text-primary-600 text-sm font-semibold"><i class="fas fa-eye mr-1"></i>Bekijk details</span></div></div></a>';
          });
          html += '</div>';
        }
        html += '</div></div>';

        // Tabs content
        html += '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">';

        // Lab Tests
        const labs = (p.lab_tests||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        html += '<div class="bg-white rounded-xl shadow"><div class="p-4 border-b"><h3 class="font-bold text-lg"><i class="fas fa-flask mr-2 text-blue-600"></i>Lab-testen</h3></div><div class="p-4">';
        if (!labs.length) { html += '<p class="text-gray-400 text-center py-4">Geen lab-testen</p>'; }
        else {
          labs.forEach(lab => {
            const statusBadge = {recommended:'bg-yellow-100 text-yellow-700',ordered:'bg-blue-100 text-blue-700',completed:'bg-green-100 text-green-700'}[lab.status]||'bg-gray-100';
            const statusLabel = {recommended:'Aanbevolen',ordered:'Aangevraagd',completed:'Voltooid'}[lab.status]||lab.status;
            html += '<div class="border rounded-lg p-3 mb-3"><div class="flex items-center justify-between mb-2"><span class="font-semibold text-sm">'+lab.test_package+'</span><span class="px-2 py-1 rounded-full text-xs font-semibold '+statusBadge+'">'+statusLabel+'</span></div>';
            if (lab.status === 'recommended' || lab.status === 'ordered') {
              html += '<a href="/lab-entry/'+patientId+'/'+lab.id+'" class="text-sm text-blue-600 hover:text-blue-800 font-semibold"><i class="fas fa-edit mr-1"></i>Resultaten invoeren</a>';
            }
            if (lab.status === 'completed' && lab.interpretations?.length) {
              html += '<div class="mt-2 space-y-1">';
              lab.interpretations.forEach(interp => {
                const statusIcon = interp.status==='optimal'?'<i class="fas fa-check-circle text-green-500"></i>':interp.status==='low'?'<i class="fas fa-arrow-down text-orange-500"></i>':'<i class="fas fa-arrow-up text-red-500"></i>';
                html += '<div class="flex items-center gap-2 text-sm">'+statusIcon+' <span class="font-medium">'+interp.name+':</span> <span>'+interp.value+' '+interp.unit+'</span>'+(interp.alert?' <span class="text-xs text-red-600">('+interp.alert+')</span>':'')+'</div>';
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
            html += '<a href="/protocol/'+patientId+'/'+proto.id+'" class="text-sm text-purple-600 hover:text-purple-800 font-semibold"><i class="fas fa-eye mr-1"></i>Bekijk volledig protocol ('+supps.length+' supplementen)</a></div>';
          });
        }
        html += '</div></div>';

        html += '</div>'; // close grid

        // Progress
        const progress = (p.progress_tracking||[]).sort((a,b)=>new Date(a.measurement_date)-new Date(b.measurement_date));
        html += '<div class="bg-white rounded-xl shadow mt-6"><div class="p-4 border-b flex items-center justify-between"><h3 class="font-bold text-lg"><i class="fas fa-chart-line mr-2 text-teal-600"></i>Progressie</h3><button onclick="showProgressForm()" class="bg-teal-600 text-white px-3 py-1 rounded text-sm font-semibold hover:bg-teal-700"><i class="fas fa-plus mr-1"></i>Meting toevoegen</button></div><div class="p-4">';
        if (!progress.length) { html += '<p class="text-gray-400 text-center py-4">Nog geen metingen</p>'; }
        else {
          html += '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left border-b"><th class="pb-2">Datum</th><th class="pb-2">Gewicht</th><th class="pb-2">Buikomvang</th><th class="pb-2">Energie</th><th class="pb-2">Notities</th></tr></thead><tbody>';
          progress.forEach(m => {
            html += '<tr class="border-b"><td class="py-2">'+new Date(m.measurement_date).toLocaleDateString('nl-NL')+'</td><td class="py-2">'+(m.weight_kg||'-')+' kg</td><td class="py-2">'+(m.waist_cm||'-')+' cm</td><td class="py-2">'+(m.energy_level?m.energy_level+'/10':'-')+'</td><td class="py-2 text-gray-500">'+(m.notes||'-')+'</td></tr>';
          });
          html += '</tbody></table></div>';
        }
        html += '<div id="progress-form" class="hidden mt-4 border-t pt-4"><h4 class="font-bold mb-3">Nieuwe meting</h4><form onsubmit="saveProgress(event)" class="grid grid-cols-2 md:grid-cols-4 gap-3"><input name="measurement_date" type="date" required class="border rounded px-3 py-2" value="'+new Date().toISOString().split('T')[0]+'"><input name="weight_kg" type="number" step="0.1" placeholder="Gewicht (kg)" class="border rounded px-3 py-2"><input name="waist_cm" type="number" step="0.1" placeholder="Buikomvang (cm)" class="border rounded px-3 py-2"><input name="energy_level" type="number" min="1" max="10" placeholder="Energie (1-10)" class="border rounded px-3 py-2"><input name="notes" placeholder="Notities..." class="border rounded px-3 py-2 col-span-2"><button type="submit" class="bg-teal-600 text-white px-4 py-2 rounded font-semibold">Opslaan</button></form></div>';
        html += '</div></div>';

        document.getElementById('profile-container').innerHTML = html;
      } catch(e) {
        document.getElementById('profile-container').innerHTML = '<p class="text-red-500 text-center py-12">Fout: '+e.message+'</p>';
      }
    }

    function showProgressForm() { document.getElementById('progress-form').classList.toggle('hidden'); }

    async function saveProgress(e) {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      data.patient_id = patientId;
      Object.keys(data).forEach(k=>{if(!data[k])delete data[k];if(k==='weight_kg'||k==='waist_cm')data[k]=parseFloat(data[k]);if(k==='energy_level')data[k]=parseInt(data[k]);});
      try {
        const res = await fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
        if(res.ok) loadProfile();
        else alert('Fout bij opslaan');
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

    loadProfile();
  </script>
</body></html>`)
})

// LAB RESULTS ENTRY PAGE
app.get('/lab-entry/:patientId/:labId', (c) => {
  const patientId = c.req.param('patientId')
  const labId = c.req.param('labId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-3xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
    <div class="bg-white rounded-xl shadow">
      <div class="bg-gradient-to-r from-green-500 to-teal-500 text-white p-6 rounded-t-xl">
        <h2 class="text-2xl font-bold"><i class="fas fa-vial mr-2"></i>Lab-resultaten Invoeren</h2>
        <p class="opacity-90 mt-1">Voer de lab-waarden in voor automatische interpretatie</p>
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
      TSH:{unit:'mU/L',min:0.4,max:2.5},fT4:{unit:'pmol/L',min:12,max:22},fT3:{unit:'pmol/L',min:4.0,max:6.5},
      INS:{unit:'mU/L',min:2,max:6},HOMA:{unit:'',min:0.5,max:2.0},CORT:{unit:'nmol/L',min:250,max:700},
      FER:{unit:'µg/L',min:30,max:100},VITD:{unit:'nmol/L',min:75,max:125},COQ10:{unit:'µmol/L',min:0.5,max:1.5},
      HBA1C:{unit:'%',min:4.0,max:5.6},CRP:{unit:'mg/L',min:0,max:1.0},GLUC:{unit:'mmol/L',min:3.9,max:5.5},
      CHOL:{unit:'mmol/L',min:0,max:5.0},HDL:{unit:'mmol/L',min:1.0,max:99},LDL:{unit:'mmol/L',min:0,max:3.0},
      TG:{unit:'mmol/L',min:0,max:1.7},B12:{unit:'pmol/L',min:300,max:900}
    };

    async function loadLabForm() {
      try {
        const res = await fetch('/api/lab-tests/'+patientId);
        const labs = await res.json();
        const lab = labs.find(l=>l.id===labId);
        if(!lab) { document.getElementById('lab-form-container').innerHTML='<p class="text-red-500">Lab test niet gevonden</p>'; return; }

        const tests = lab.recommended_tests || [];
        let html = '<form onsubmit="submitResults(event)" class="space-y-4">';
        html += '<div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-4 rounded"><p class="text-sm text-blue-700"><i class="fas fa-info-circle mr-1"></i>Voer alleen de waarden in die beschikbaar zijn. De optimale range wordt getoond als referentie.</p></div>';

        const required = tests.filter(t=>t.required);
        const optional = tests.filter(t=>!t.required);

        html += '<h3 class="font-bold text-lg">Verplichte testen</h3>';
        required.forEach(t => {
          const ref = refRanges[t.code];
          html += '<div class="flex items-center gap-4 border-b pb-3"><div class="flex-1"><label class="block text-sm font-semibold text-gray-700">'+t.name+'</label>'+(ref?'<span class="text-xs text-gray-400">Optimaal: '+ref.min+' - '+ref.max+' '+ref.unit+'</span>':'')+'</div><div class="w-40"><input name="'+t.code+'" type="number" step="0.01" class="w-full border rounded px-3 py-2 text-right" placeholder="Waarde"></div><span class="text-sm text-gray-400 w-16">'+(ref?ref.unit:'')+'</span></div>';
        });

        if (optional.length) {
          html += '<h3 class="font-bold text-lg mt-6">Optionele testen</h3>';
          optional.forEach(t => {
            const ref = refRanges[t.code];
            html += '<div class="flex items-center gap-4 border-b pb-3"><div class="flex-1"><label class="block text-sm font-semibold text-gray-700">'+t.name+'</label>'+(ref?'<span class="text-xs text-gray-400">Optimaal: '+ref.min+' - '+ref.max+' '+ref.unit+'</span>':'')+(t.note?'<span class="text-xs text-blue-500 block">'+t.note+'</span>':'')+'</div><div class="w-40"><input name="'+t.code+'" type="number" step="0.01" class="w-full border rounded px-3 py-2 text-right" placeholder="Waarde"></div><span class="text-sm text-gray-400 w-16">'+(ref?ref.unit:'')+'</span></div>';
          });
        }

        html += '<div class="flex gap-4 mt-6"><button type="submit" class="bg-green-600 text-white px-8 py-3 rounded-lg font-bold hover:bg-green-700"><i class="fas fa-save mr-2"></i>Opslaan & Interpreteer</button><a href="/patient/'+patientId+'" class="px-6 py-3 rounded-lg border text-gray-600 hover:bg-gray-50">Annuleren</a></div></form>';

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
        if(res.ok) { window.location.href = '/patient/'+patientId; }
        else alert('Fout: '+(data.error||'Onbekend'));
      } catch(e) { alert('Fout: '+e.message); }
    }

    loadLabForm();
  </script>
</body></html>`)
})

// ASSESSMENT DETAIL PAGE - Volledige vragenlijst teruglezen
app.get('/assessment/:patientId/:assessmentId', (c) => {
  const patientId = c.req.param('patientId')
  const assessmentId = c.req.param('assessmentId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-4xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
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
        html += '<div class="bg-white rounded-xl shadow mb-6"><div class="bg-gradient-to-r from-blue-600 to-cyan-600 text-white p-6 rounded-t-xl"><div class="flex items-center justify-between"><div><h2 class="text-2xl font-bold"><i class="fas fa-clipboard-list mr-2"></i>'+typeLabel+': '+patient.first_name+' '+patient.last_name+'</h2><p class="opacity-90 mt-1"><i class="far fa-calendar mr-1"></i> '+date+'</p></div><div class="flex gap-2"><a href="/results/'+patientId+'/'+assessmentId+'" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-semibold"><i class="fas fa-chart-bar mr-1"></i>Resultaten</a><button onclick="window.print()" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-semibold"><i class="fas fa-print mr-1"></i>Print</button></div></div></div>';

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
        html += '<div class="p-6 border-t bg-gray-50 rounded-b-xl flex flex-wrap gap-3"><a href="/patient/'+patientId+'" class="bg-primary-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-primary-700"><i class="fas fa-user mr-2"></i>Patiëntprofiel</a><a href="/results/'+patientId+'/'+assessmentId+'" class="bg-green-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-green-700"><i class="fas fa-chart-bar mr-2"></i>Resultaten & Lab</a><button onclick="window.print()" class="border border-gray-300 px-6 py-3 rounded-lg font-medium hover:bg-white"><i class="fas fa-print mr-2"></i>Print Assessment</button></div>';

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
app.get('/protocol/:patientId/:protocolId', (c) => {
  const patientId = c.req.param('patientId')
  const protocolId = c.req.param('protocolId')
  return c.html(`${htmlHead}
<body class="bg-gray-50 min-h-screen">
  ${navBar}
  <main class="max-w-4xl mx-auto px-4 py-8">
    <div class="mb-6"><a href="/patient/${patientId}" class="text-primary-600 hover:text-primary-800 text-sm"><i class="fas fa-arrow-left mr-1"></i> Terug naar patiënt</a></div>
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
        html += '<div class="flex gap-3 mt-6 border-t pt-6"><button onclick="window.print()" class="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-blue-700"><i class="fas fa-print mr-2"></i>Print Protocol</button><a href="/patient/'+patientId+'" class="border border-gray-300 px-6 py-3 rounded-lg font-medium hover:bg-gray-50"><i class="fas fa-arrow-left mr-2"></i>Terug naar patiënt</a></div>';

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

export default app
