// =====================================================
// Lab Test Recommendations Engine
// Genereert lab-test pakketten op basis van categorieën
// =====================================================

export interface LabTest {
  name: string
  code: string
  required: boolean
  category: string
  note?: string
}

export interface LabPackage {
  name: string
  tests: LabTest[]
}

const BASE_PACKAGE: LabTest[] = [
  { name: 'TSH', code: 'TSH', required: true, category: 'Schildklier' },
  { name: 'Vrij T4 (fT4)', code: 'fT4', required: true, category: 'Schildklier' },
  { name: 'Glucose (nuchter)', code: 'GLUC', required: true, category: 'Metabolisme' },
  { name: 'HbA1c', code: 'HBA1C', required: true, category: 'Metabolisme' },
  { name: 'Totaal Cholesterol', code: 'CHOL', required: true, category: 'Lipiden' },
  { name: 'HDL-cholesterol', code: 'HDL', required: true, category: 'Lipiden' },
  { name: 'LDL-cholesterol', code: 'LDL', required: true, category: 'Lipiden' },
  { name: 'Triglyceriden', code: 'TG', required: true, category: 'Lipiden' },
  { name: 'ALAT (leverfunctie)', code: 'ALAT', required: true, category: 'Lever' },
  { name: 'ASAT (leverfunctie)', code: 'ASAT', required: true, category: 'Lever' },
  { name: 'Creatinine + eGFR', code: 'CREA', required: true, category: 'Nier' },
  { name: 'Hemoglobine (Hb)', code: 'HB', required: true, category: 'Bloed' },
  { name: 'MCV', code: 'MCV', required: true, category: 'Bloed' },
]

const CATEGORY_TESTS: Record<string, LabTest[]> = {
  metabolic_resistance: [
    { name: 'Vrij T3 (fT3)', code: 'fT3', required: true, category: 'Schildklier' },
    { name: 'Insuline (nuchter)', code: 'INS', required: true, category: 'Metabolisme' },
    { name: 'HOMA-IR (berekend)', code: 'HOMA', required: true, category: 'Metabolisme' },
    { name: 'Cortisol (ochtend 8:00u)', code: 'CORT', required: true, category: 'Bijnier' },
    { name: 'DHEA-S', code: 'DHEAS', required: true, category: 'Bijnier' },
    { name: 'Vitamine D (25-OH)', code: 'VITD', required: true, category: 'Vitaminen' },
    { name: 'Ferritine', code: 'FER', required: true, category: 'Mineralen' },
    { name: 'CRP (ontstekingsmarker)', code: 'CRP', required: true, category: 'Ontsteking' },
    { name: 'Reverse T3 (rT3)', code: 'rT3', required: false, category: 'Schildklier', note: 'Bij vermoeden conversieprobleem' },
    { name: 'IGF-1', code: 'IGF1', required: false, category: 'Hormonen' },
    { name: 'Homocysteïne', code: 'HCY', required: false, category: 'Metabolisme' },
    { name: 'Vitamine B12', code: 'B12', required: false, category: 'Vitaminen' },
    { name: 'Zink (plasma)', code: 'ZN', required: false, category: 'Mineralen' },
    { name: 'Selenium', code: 'SE', required: false, category: 'Mineralen' },
  ],
  thyroid: [
    { name: 'Vrij T3 (fT3)', code: 'fT3', required: true, category: 'Schildklier' },
    { name: 'TPO-antistoffen', code: 'TPO', required: true, category: 'Schildklier' },
    { name: 'Anti-Tg antistoffen', code: 'ATG', required: true, category: 'Schildklier' },
    { name: 'Selenium', code: 'SE', required: true, category: 'Mineralen' },
    { name: 'Zink (plasma)', code: 'ZN', required: true, category: 'Mineralen' },
    { name: 'Ferritine', code: 'FER', required: true, category: 'Mineralen' },
    { name: 'Vitamine D (25-OH)', code: 'VITD', required: true, category: 'Vitaminen' },
    { name: 'Reverse T3 (rT3)', code: 'rT3', required: false, category: 'Schildklier', note: 'Bij vermoeden conversieprobleem' },
    { name: 'Jodium (urine)', code: 'IODINE', required: false, category: 'Mineralen' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: false, category: 'Mineralen' },
  ],
  hormonal: [
    { name: 'Insuline (nuchter)', code: 'INS', required: true, category: 'Metabolisme' },
    { name: 'HOMA-IR (berekend)', code: 'HOMA', required: true, category: 'Metabolisme' },
    { name: 'Testosteron (vrij)', code: 'TESTO', required: true, category: 'Hormonen' },
    { name: 'DHEA-S', code: 'DHEAS', required: true, category: 'Hormonen' },
    { name: 'LH / FSH ratio', code: 'LH_FSH', required: true, category: 'Hormonen' },
    { name: 'Progesteron (dag 21)', code: 'PROG', required: true, category: 'Hormonen', note: 'Luteale fase' },
    { name: 'Vitamine D (25-OH)', code: 'VITD', required: true, category: 'Vitaminen' },
    { name: 'SHBG', code: 'SHBG', required: false, category: 'Hormonen' },
    { name: 'Oestradiol', code: 'E2', required: false, category: 'Hormonen' },
    { name: 'Prolactine', code: 'PRL', required: false, category: 'Hormonen' },
    { name: 'AMH', code: 'AMH', required: false, category: 'Hormonen', note: 'Vruchtbaarheidsindicator' },
  ],
  cortisol: [
    { name: 'Cortisol (ochtend 8:00u)', code: 'CORT', required: true, category: 'Bijnier' },
    { name: 'DHEA-S', code: 'DHEAS', required: true, category: 'Bijnier' },
    { name: 'Cortisol/DHEA-S ratio', code: 'CORT_RATIO', required: true, category: 'Bijnier' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: true, category: 'Mineralen' },
    { name: 'Vitamine B-complex', code: 'BCOMPLEX', required: true, category: 'Vitaminen' },
    { name: '4-punts cortisol dagcurve', code: 'CORT_4P', required: false, category: 'Bijnier', note: 'Speekseltest' },
    { name: 'Vitamine C', code: 'VITC', required: false, category: 'Vitaminen' },
  ],
  insulin: [
    { name: 'Insuline (nuchter)', code: 'INS', required: true, category: 'Metabolisme' },
    { name: 'HOMA-IR (berekend)', code: 'HOMA', required: true, category: 'Metabolisme' },
    { name: 'Triglyceriden', code: 'TG', required: true, category: 'Lipiden' },
    { name: 'HDL/LDL ratio', code: 'HDL_LDL', required: true, category: 'Lipiden' },
    { name: 'Chromium', code: 'CR', required: true, category: 'Mineralen' },
    { name: 'C-peptide', code: 'CPEP', required: false, category: 'Metabolisme' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: false, category: 'Mineralen' },
  ],
  medication: [
    { name: 'CoQ10 (plasma)', code: 'COQ10', required: true, category: 'Supplementen', note: 'Bij statinegebruik' },
    { name: 'CK (creatinekinase)', code: 'CK', required: true, category: 'Spier', note: 'Bij statinegebruik' },
    { name: 'Vitamine B12', code: 'B12', required: true, category: 'Vitaminen', note: 'Bij metforminegebruik' },
    { name: 'Folaat', code: 'FOL', required: true, category: 'Vitaminen' },
    { name: 'Homocysteïne', code: 'HCY', required: true, category: 'Metabolisme' },
    { name: 'Carnitine (plasma)', code: 'CARN', required: false, category: 'Supplementen' },
  ],
  standard: [
    { name: 'Vitamine D (25-OH)', code: 'VITD', required: false, category: 'Vitaminen' },
    { name: 'Ferritine', code: 'FER', required: false, category: 'Mineralen' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: false, category: 'Mineralen' },
  ],
}

export function getLabRecommendations(categoryIds: string[]): LabPackage {
  const testsMap = new Map<string, LabTest>()

  // Add base package
  for (const test of BASE_PACKAGE) {
    testsMap.set(test.code, test)
  }

  // Add category-specific tests
  for (const catId of categoryIds) {
    const catTests = CATEGORY_TESTS[catId] || []
    for (const test of catTests) {
      const existing = testsMap.get(test.code)
      if (!existing) {
        testsMap.set(test.code, test)
      } else if (test.required && !existing.required) {
        testsMap.set(test.code, { ...existing, required: true })
      }
    }
  }

  const tests = Array.from(testsMap.values())
  tests.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1
    return a.category.localeCompare(b.category)
  })

  return {
    name: categoryIds.length > 1
      ? `Uitgebreid pakket: ${categoryIds.join(' + ')}`
      : categoryIds[0] || 'Basis pakket',
    tests
  }
}

// =====================================================
// Lab Result Interpretation
// =====================================================

export interface LabReference {
  code: string
  name: string
  optimalMin: number
  optimalMax: number
  unit: string
  lowAlert: string
  highAlert: string
  lowActions: string[]
  highActions: string[]
}

export const LAB_REFERENCES: LabReference[] = [
  {
    code: 'TSH', name: 'TSH', optimalMin: 0.4, optimalMax: 2.5, unit: 'mU/L',
    lowAlert: 'Mogelijk hyperthyreoïdie',
    highAlert: 'Mogelijk hypothyreoïdie',
    lowActions: ['Verwijs endocrinoloog', 'Check fT3, fT4'],
    highActions: ['Check fT3, fT4, TPO', 'Verwijs huisarts', 'Start Se + Zn suppletie']
  },
  {
    code: 'fT3', name: 'Vrij T3', optimalMin: 4.0, optimalMax: 6.5, unit: 'pmol/L',
    lowAlert: 'Lage T3 conversie',
    highAlert: 'Verhoogd fT3',
    lowActions: ['Check rT3', 'Start L-carnitine', 'Selenium, zink, magnesium'],
    highActions: ['Verwijs endocrinoloog']
  },
  {
    code: 'fT4', name: 'Vrij T4', optimalMin: 12, optimalMax: 22, unit: 'pmol/L',
    lowAlert: 'Laag fT4', highAlert: 'Hoog fT4',
    lowActions: ['Check TSH, TPO', 'Evalueer schildklierfunctie'],
    highActions: ['Verwijs endocrinoloog']
  },
  {
    code: 'INS', name: 'Insuline (nuchter)', optimalMin: 2, optimalMax: 6, unit: 'mU/L',
    lowAlert: '', highAlert: 'Insulineresistentie',
    lowActions: [],
    highActions: ['Bereken HOMA-IR', 'Koolhydraatrestrictie', 'Start myo-inositol + chromium', 'Overweeg metformine (huisarts)']
  },
  {
    code: 'HOMA', name: 'HOMA-IR', optimalMin: 0.5, optimalMax: 2.0, unit: '',
    lowAlert: '', highAlert: 'Insulineresistentie',
    lowActions: [],
    highActions: ['Koolhydraatrestrictie (50-100g/dag)', 'Intervalvasten 16:8', 'Myo-inositol 2000-4000 mg', 'Chromium 200-400 mcg']
  },
  {
    code: 'CORT', name: 'Cortisol (ochtend)', optimalMin: 250, optimalMax: 700, unit: 'nmol/L',
    lowAlert: 'Lage cortisol - bijnieruitputting',
    highAlert: 'Verhoogd cortisol - stress',
    lowActions: ['Bijnierondersteuning', 'Vitamine C 1000 mg', 'B5 (pantotheenzuur) 200 mg', 'Verwijs endocrinoloog (uitsluiten Addison)'],
    highActions: ['Stressmanagement protocol', 'Fosfatidylserine 300 mg', 'Ashwagandha 2x300 mg', 'Check slaap, werk-stress']
  },
  {
    code: 'FER', name: 'Ferritine', optimalMin: 30, optimalMax: 100, unit: 'µg/L',
    lowAlert: 'IJzerdeficiëntie',
    highAlert: 'Verhoogd ferritine (ontsteking?)',
    lowActions: ['IJzersuppletie (bisglycinaat)', 'Check Hb, MCV', 'Vitamine C (absorptie)'],
    highActions: ['Uitsluiten hemochromatose', 'Check CRP, leverfunctie']
  },
  {
    code: 'VITD', name: 'Vitamine D', optimalMin: 75, optimalMax: 125, unit: 'nmol/L',
    lowAlert: 'Vitamine D tekort',
    highAlert: 'Vitamine D te hoog',
    lowActions: ['Start 4000 IE/dag', 'Retest na 3 maanden'],
    highActions: ['Stop suppletie', 'Retest na 4 weken']
  },
  {
    code: 'COQ10', name: 'CoQ10', optimalMin: 0.5, optimalMax: 1.5, unit: 'µmol/L',
    lowAlert: 'CoQ10 deficiëntie',
    highAlert: '',
    lowActions: ['Ubiquinol 200-300 mg/dag', 'Check statinegebruik', 'Monitor spierpijn'],
    highActions: []
  },
  {
    code: 'HBA1C', name: 'HbA1c', optimalMin: 4.0, optimalMax: 5.6, unit: '%',
    lowAlert: '', highAlert: 'Prediabetes/diabetes',
    lowActions: [],
    highActions: ['Koolhydraatrestrictie', 'Berberine of metformine', 'Verwijs huisarts']
  },
  {
    code: 'CRP', name: 'CRP', optimalMin: 0, optimalMax: 1.0, unit: 'mg/L',
    lowAlert: '', highAlert: 'Verhoogde ontsteking',
    lowActions: [],
    highActions: ['Omega-3 (2000mg EPA+DHA)', 'Curcumine 500mg', 'Anti-inflammatoir dieet']
  },
]

export interface LabInterpretation {
  code: string
  name: string
  value: number
  unit: string
  status: 'optimal' | 'low' | 'high'
  alert: string
  actions: string[]
}

export function interpretLabResults(results: Record<string, number>): LabInterpretation[] {
  const interpretations: LabInterpretation[] = []

  for (const [code, value] of Object.entries(results)) {
    const ref = LAB_REFERENCES.find(r => r.code === code)
    if (!ref) continue

    let status: 'optimal' | 'low' | 'high' = 'optimal'
    let alert = ''
    let actions: string[] = []

    if (value < ref.optimalMin) {
      status = 'low'
      alert = ref.lowAlert
      actions = ref.lowActions
    } else if (value > ref.optimalMax) {
      status = 'high'
      alert = ref.highAlert
      actions = ref.highActions
    }

    interpretations.push({
      code, name: ref.name, value, unit: ref.unit,
      status, alert, actions
    })
  }

  return interpretations
}
