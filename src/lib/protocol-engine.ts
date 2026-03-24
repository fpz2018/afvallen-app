// =====================================================
// Protocol Generation Engine
// Genereert gepersonaliseerde protocollen per categorie
// =====================================================

export interface Supplement {
  name: string
  dosage: string
  timing: string
  reason: string
  duration: string
}

export interface NutritionPlan {
  calories?: string
  carbs: string
  protein: string
  fats: string
  fiber: string
  avoid: string[]
  recommend: string[]
}

export interface LifestylePlan {
  exercise: string[]
  sleep: string[]
  stress: string[]
}

export interface MedicationAdvice {
  recommendation: string
  dosage: string
  monitoring: string
  forDoctor: boolean
}

export interface Protocol {
  categories: string[]
  supplements: Supplement[]
  nutrition: NutritionPlan
  lifestyle: LifestylePlan
  medicationAdvice: MedicationAdvice[]
  followUp: { period: string; action: string; goal: string }[]
  warnings: string[]
}

const SUPPLEMENT_DB: Record<string, Supplement[]> = {
  metabolic_resistance: [
    { name: 'Vitamine D3', dosage: '4000 IE/dag', timing: 'Ochtend bij vetrijke maaltijd', reason: 'Metabole ondersteuning', duration: '3 maanden, daarna retest' },
    { name: 'Magnesium citraat', dosage: '400 mg/dag', timing: 'Avond', reason: 'Insulinegevoeligheid & slaap', duration: 'Doorlopend' },
    { name: 'Omega-3 (EPA+DHA)', dosage: '2000 mg/dag', timing: 'Bij maaltijd', reason: 'Ontsteking ↓, hormoonbalans', duration: 'Doorlopend' },
    { name: 'L-Carnitine', dosage: '1000-2000 mg/dag', timing: 'Ochtend nuchter', reason: 'Vetverbranding & energie', duration: '3 maanden' },
  ],
  thyroid: [
    { name: 'Selenium (selenomethionine)', dosage: '200 mcg/dag', timing: 'Bij maaltijd', reason: 'T4→T3 conversie, TPO verlaging', duration: '6 maanden' },
    { name: 'Zink bisglycinaat', dosage: '25 mg/dag', timing: 'Bij maaltijd', reason: 'Schildklierfunctie', duration: '3 maanden' },
    { name: 'Vitamine D3', dosage: '4000 IE/dag', timing: 'Ochtend', reason: 'Immuunmodulatie bij Hashimoto', duration: '3 maanden, retest' },
    { name: 'IJzer bisglycinaat', dosage: '25 mg/dag', timing: '2u apart van schildkliermedicatie', reason: 'Ferritine optimalisatie', duration: 'Tot ferritine >50' },
    { name: 'Vitamine B-complex', dosage: '1x/dag', timing: 'Ochtend', reason: 'Energie & methylering', duration: 'Doorlopend' },
  ],
  hormonal: [
    { name: 'Myo-inositol', dosage: '2x 2000 mg/dag', timing: 'Ochtend + avond', reason: 'PCOS, insulinegevoeligheid ↑', duration: '6 maanden' },
    { name: 'Chromium', dosage: '200-400 mcg/dag', timing: 'Bij lunch', reason: 'Bloedsuiker regulatie', duration: '3 maanden' },
    { name: 'Vitamine D3', dosage: '4000 IE/dag', timing: 'Ochtend', reason: 'Hormoonbalans', duration: '3 maanden, retest' },
    { name: 'Omega-3 (EPA+DHA)', dosage: '2000 mg/dag', timing: 'Bij maaltijd', reason: 'Ontsteking ↓, hormonen', duration: 'Doorlopend' },
    { name: 'Magnesium citraat', dosage: '400 mg/dag', timing: 'Avond', reason: 'Insuline & slaap', duration: 'Doorlopend' },
    { name: 'Zink bisglycinaat', dosage: '25 mg/dag', timing: 'Bij maaltijd', reason: 'Anti-androgeen effect', duration: '3 maanden' },
  ],
  cortisol: [
    { name: 'Ashwagandha (KSM-66)', dosage: '2x 300 mg/dag', timing: 'Ochtend + avond', reason: 'Cortisol verlaging', duration: '3 maanden' },
    { name: 'Fosfatidylserine', dosage: '300 mg/dag', timing: 'Avond', reason: 'Cortisol verlaging', duration: '2 maanden' },
    { name: 'Magnesium citraat', dosage: '400-600 mg/dag', timing: 'Avond', reason: 'Ontspanning & slaap', duration: 'Doorlopend' },
    { name: 'Vitamine B-complex', dosage: '1x/dag', timing: 'Ochtend', reason: 'Bijnierschorsondersteuning', duration: 'Doorlopend' },
    { name: 'Vitamine C', dosage: '1000 mg/dag', timing: 'Gespreid over dag', reason: 'Bijnierfunctie', duration: 'Doorlopend' },
    { name: 'L-Theanine', dosage: '200 mg/dag', timing: 'Bij stress of avond', reason: 'Ontspanning zonder slaperigheid', duration: 'Naar behoefte' },
  ],
  insulin: [
    { name: 'Myo-inositol', dosage: '2x 2000 mg/dag', timing: 'Ochtend + avond', reason: 'Insulinegevoeligheid ↑', duration: '6 maanden' },
    { name: 'Chromium', dosage: '200-400 mcg/dag', timing: 'Bij lunch', reason: 'Bloedsuiker regulatie', duration: '3 maanden' },
    { name: 'Berberine', dosage: '3x 500 mg/dag', timing: 'Bij maaltijden', reason: 'Bloedsuiker ↓, AMPK activatie', duration: '3 maanden' },
    { name: 'Magnesium citraat', dosage: '400 mg/dag', timing: 'Avond', reason: 'Insulinegevoeligheid', duration: 'Doorlopend' },
    { name: 'Alpha-liponzuur', dosage: '600 mg/dag', timing: 'Nuchter', reason: 'Antioxidant, insulinegevoeligheid', duration: '3 maanden' },
    { name: 'Omega-3 (EPA+DHA)', dosage: '2000 mg/dag', timing: 'Bij maaltijd', reason: 'Triglyceriden ↓', duration: 'Doorlopend' },
  ],
  medication: [
    { name: 'Ubiquinol (CoQ10)', dosage: '200-300 mg/dag', timing: 'Bij vetrijke maaltijd', reason: 'Statine-geïnduceerde depletie', duration: 'Zolang statine gebruikt wordt' },
    { name: 'Vitamine B12 (methylcobalamine)', dosage: '1000 mcg/dag', timing: 'Ochtend', reason: 'Metformine-depletie', duration: 'Zolang metformine gebruikt wordt' },
    { name: 'Folaat (5-MTHF)', dosage: '400-800 mcg/dag', timing: 'Ochtend', reason: 'Methylering', duration: 'Doorlopend' },
    { name: 'Magnesium citraat', dosage: '400 mg/dag', timing: 'Avond', reason: 'Algemene ondersteuning', duration: 'Doorlopend' },
  ],
  standard: [
    { name: 'Multivitamine (hoog gedoseerd)', dosage: '1x/dag', timing: 'Bij ontbijt', reason: 'Basis nutritionele ondersteuning', duration: 'Doorlopend' },
    { name: 'Omega-3 (EPA+DHA)', dosage: '1000 mg/dag', timing: 'Bij maaltijd', reason: 'Algemene gezondheid', duration: 'Doorlopend' },
    { name: 'Vitamine D3', dosage: '2000 IE/dag', timing: 'Ochtend', reason: 'Algemene ondersteuning', duration: 'Doorlopend (winter)' },
    { name: 'Magnesium citraat', dosage: '300 mg/dag', timing: 'Avond', reason: 'Slaap & herstel', duration: 'Doorlopend' },
  ],
}

const NUTRITION_DB: Record<string, Partial<NutritionPlan>> = {
  metabolic_resistance: {
    carbs: '80-120 g/dag (laag-glycemisch)',
    protein: '1,6-2,0 g/kg lichaamsgewicht',
    fats: '60-80 g/dag (omega-3, olijfolie, avocado)',
    fiber: 'Minimaal 30 g/dag',
    avoid: ['Geraffineerde suikers', 'Bewerkte koolhydraten', 'Alcohol', 'Transvetten'],
    recommend: ['Groene groenten', 'Vette vis (2-3x/week)', 'Noten en zaden', 'Eieren', 'Intervalvasten 16:8']
  },
  hormonal: {
    carbs: '50-100 g/dag (laag-glycemisch, PCOS)',
    protein: '1,6 g/kg lichaamsgewicht (±120g/dag)',
    fats: '60-70 g/dag (focus omega-3, olijfolie)',
    fiber: 'Minimaal 30 g/dag',
    avoid: ['Geraffineerde suikers en zoetstoffen', 'Bewerkte koolhydraten (wit brood, pasta)', 'Zuivel (eerste 3 maanden beperken)', 'Soja-producten (oestrogeenmimickers)'],
    recommend: ['Kruisbloemige groenten (broccoli, bloemkool)', 'Vette vis', 'Bessen (antioxidanten)', 'Spearmint thee (anti-androgeen)', 'Kaneel (bloedsuiker)']
  },
  insulin: {
    carbs: '50-80 g/dag (strikt laag-glycemisch)',
    protein: '1,6-2,0 g/kg lichaamsgewicht',
    fats: '70-90 g/dag (gezonde vetten)',
    fiber: 'Minimaal 35 g/dag',
    avoid: ['ALLE geraffineerde suikers', 'Wit brood, pasta, rijst', 'Fruitspanning > 2 porties/dag', 'Alcohol', 'Vruchtensappen'],
    recommend: ['Intervalvasten 16:8 of 18:6', 'Azijn voor maaltijden (bloedsuiker)', 'Kaneel', 'Groene groenten onbeperkt', 'Eiwitten bij elke maaltijd']
  },
  cortisol: {
    carbs: '100-150 g/dag (niet te streng!)',
    protein: '1,4-1,6 g/kg lichaamsgewicht',
    fats: '60-70 g/dag',
    fiber: 'Minimaal 25 g/dag',
    avoid: ['Cafeïne na 12:00', 'Alcohol', 'Geraffineerde suikers', 'Zeer streng diëten (verhoogt cortisol!)'],
    recommend: ['Regelmatige maaltijden (3x/dag + 1-2 snacks)', 'Adaptogene kruiden (thee)', 'Donkere chocolade (70%+)', 'Warme maaltijden', 'NIET te streng koolhydraatarm!']
  },
  standard: {
    carbs: '120-180 g/dag (volwaardige bronnen)',
    protein: '1,4-1,6 g/kg lichaamsgewicht',
    fats: '50-70 g/dag',
    fiber: 'Minimaal 25 g/dag',
    avoid: ['Geraffineerde suikers', 'Ultra-bewerkte voeding', 'Overmatig alcohol'],
    recommend: ['Schijf van Vijf als basis', 'Eiwitrijk ontbijt', '400g groenten/dag', '2 stuks fruit/dag', 'Voldoende water (1,5-2L)']
  },
}

// Hulpfunctie: parseer de hoogste doseerwaarde uit een string (bijv. "400-600 mg" → 600)
function parseDosageMax(dosage: string): number {
  const numbers = dosage.match(/\d+/g)?.map(Number) || [0]
  return Math.max(...numbers)
}

export function generateProtocol(categoryIds: string[]): Protocol {
  // Collect supplements — bij duplicaten de hoogste dosering bewaren
  const supplementMap = new Map<string, Supplement>()
  for (const catId of categoryIds) {
    const supplements = SUPPLEMENT_DB[catId] || []
    for (const supp of supplements) {
      const existing = supplementMap.get(supp.name)
      if (!existing || parseDosageMax(supp.dosage) > parseDosageMax(existing.dosage)) {
        supplementMap.set(supp.name, supp)
      }
    }
  }

  // Pick primary category nutrition plan (first non-standard, or standard)
  const primaryNutrition = categoryIds.find(id => id !== 'standard') || 'standard'
  const nutritionBase = NUTRITION_DB[primaryNutrition] || NUTRITION_DB['standard']

  const nutrition: NutritionPlan = {
    carbs: nutritionBase.carbs || '100-150 g/dag',
    protein: nutritionBase.protein || '1,4 g/kg',
    fats: nutritionBase.fats || '60 g/dag',
    fiber: nutritionBase.fiber || '25 g/dag',
    avoid: [...new Set(categoryIds.flatMap(id => NUTRITION_DB[id]?.avoid || []))],
    recommend: [...new Set(categoryIds.flatMap(id => NUTRITION_DB[id]?.recommend || []))],
  }

  // Lifestyle
  const lifestyle: LifestylePlan = {
    exercise: categoryIds.includes('cortisol')
      ? ['3x/week matige kracht (30 min)', '2x/week yoga of wandelen', 'Dagelijks 8000 stappen', 'GEEN intensieve HIIT (verhoogt cortisol)']
      : ['3x/week krachttraining (30-45 min)', '2x/week HIIT of cardio (20 min)', 'Dagelijks 8000-10.000 stappen', 'Actieve pauzes overdag'],
    sleep: ['Minimaal 7-8 uur per nacht', 'Vast slaapritme (±23:00 - ±07:00)', 'Geen scherm 1 uur voor bed', 'Slaapkamer koel (16-18°C) en donker', 'Magnesium + L-theanine voor bed'],
    stress: categoryIds.includes('cortisol')
      ? ['Dagelijks 10 min meditatie/ademhaling', 'Wekelijks 2x yoga of tai chi', 'Natuur wandelingen', 'Grenzen stellen (werkbelasting)', 'Journaling (stress uitschrijven)']
      : ['Regelmatig ontspanning plannen', 'Ademhalingsoefeningen bij stress', 'Sociale contacten onderhouden'],
  }

  // Medication advice
  const medicationAdvice: MedicationAdvice[] = []
  if (categoryIds.includes('insulin') || categoryIds.includes('hormonal')) {
    medicationAdvice.push({
      recommendation: 'Overweeg Metformine',
      dosage: 'Start 500 mg 1x/dag, opbouwen naar 1500-2000 mg/dag',
      monitoring: 'Vitamine B12 jaarlijks controleren',
      forDoctor: true
    })
  }
  if (categoryIds.includes('thyroid')) {
    medicationAdvice.push({
      recommendation: 'Evalueer schildkliermedicatie (levothyroxine)',
      dosage: 'Op basis van lab-waarden TSH, fT3, fT4',
      monitoring: 'TSH + fT3 + fT4 elke 6-8 weken bij dosisaanpassing',
      forDoctor: true
    })
  }

  // Conflicterende adviezen signaleren aan de therapeut
  const warnings: string[] = []
  if (categoryIds.includes('insulin') && categoryIds.includes('cortisol')) {
    warnings.push(
      'Conflicterende koolhydraatadviezen: Insuline-protocol adviseert 50-80 g/dag (strikt laag-glycemisch), ' +
      'maar Cortisol-protocol adviseert 100-150 g/dag (niet te streng!). ' +
      'Aanbeveling: begin met het cortisol-protocol (minder streng) en reduceer koolhydraten geleidelijk. ' +
      'Bespreek prioritering met de patiënt.'
    )
  }

  // Follow-up
  const followUp = [
    { period: '2 weken', action: 'Check-in gesprek', goal: 'Adherence, bijwerkingen, vragen' },
    { period: '6 weken', action: 'Meting + evaluatie', goal: 'Gewicht, buikomvang, symptomen, energie' },
    { period: '3 maanden', action: 'Lab-controle', goal: 'Hertest afwijkende waarden + gewicht' },
    { period: '6 maanden', action: 'Protocol evaluatie', goal: 'Duurzaamheid, eventueel aanpassen' },
  ]

  return {
    categories: categoryIds,
    supplements: Array.from(supplementMap.values()),
    nutrition,
    lifestyle,
    medicationAdvice,
    followUp,
    warnings,
  }
}
