// =====================================================
// Lab → Protocol Adjustment Engine
// Vertaalt afwijkende labwaarden naar concrete
// supplement- en leefstijlaanpassingen
// =====================================================
import type { LabInterpretation } from './lab-recommendations'
import type { Supplement } from './protocol-engine'

export interface ProtocolAdjustment {
  code: string                    // Lab code (bijv. 'VITD', 'FER')
  labName: string                 // Leesbare naam
  labValue: number
  unit: string
  status: 'low' | 'high'
  severity: 'critical' | 'significant' | 'moderate'
  type: 'add_supplement' | 'increase_supplement' | 'nutrition' | 'referral' | 'warning'
  supplement?: Supplement
  nutritionChange?: string
  referralNote?: string
  message: string                 // Beknopte uitleg voor de therapeut
}

// =====================================================
// Regels: labafwijking → aanpassing
// =====================================================
type AdjustmentRule = {
  status: 'low' | 'high'
  criticalThreshold?: number      // Waarde waarbij ernst = 'critical'
  severity: 'critical' | 'significant' | 'moderate'
  adjustments: Omit<ProtocolAdjustment, 'code' | 'labName' | 'labValue' | 'unit' | 'status'>[]
}

const RULES: Record<string, AdjustmentRule[]> = {
  // ── Vitaminen ──
  VITD: [
    {
      status: 'low',
      criticalThreshold: 25,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'increase_supplement',
          supplement: {
            name: 'Vitamine D3',
            dosage: '6000 IE/dag',
            timing: 'Ochtend bij vetrijke maaltijd',
            reason: 'Ernstig vitamine D tekort — verhoogde dosering noodzakelijk',
            duration: '3 maanden, daarna retest',
          },
          message: 'Vitamine D aanzienlijk verlaagd: verhoog dosering naar 6000 IE/dag en hertest na 3 maanden.',
        },
      ],
    },
  ],
  B12: [
    {
      status: 'low',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Vitamine B12 (methylcobalamine)',
            dosage: '1000 mcg/dag',
            timing: 'Ochtend, sublinguaal of bij maaltijd',
            reason: 'Vitamine B12 tekort — methylcobalamine (actieve vorm)',
            duration: '3 maanden, daarna retest',
          },
          message: 'B12 te laag: voeg methylcobalamine 1000 mcg/dag toe. Check ook homocysteïne.',
        },
      ],
    },
  ],

  // ── Mineralen ──
  FER: [
    {
      status: 'low',
      criticalThreshold: 15,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'IJzer bisglycinaat',
            dosage: '25–50 mg/dag',
            timing: 'Nuchter of met vitamine C — 2 uur apart van schildkliermedicatie',
            reason: 'Laag ferritine belemmert vetverbranding en veroorzaakt vermoeidheid',
            duration: 'Tot ferritine > 50 µg/L, daarna retest',
          },
          message: 'Ferritine te laag: voeg IJzer bisglycinaat toe. Gebruik 50 mg bij ernstig tekort (<15). Combineer met vitamine C voor betere opname.',
        },
      ],
    },
  ],
  ZN: [
    {
      status: 'low',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Zink bisglycinaat',
            dosage: '25 mg/dag',
            timing: 'Bij avondmaaltijd (niet op nuchtere maag)',
            reason: 'Zink nodig voor schildklierconversie, insulinefunctie en immuunsysteem',
            duration: '3 maanden, daarna retest',
          },
          message: 'Zink te laag: voeg Zink bisglycinaat 25 mg/dag toe.',
        },
      ],
    },
  ],
  SE: [
    {
      status: 'low',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Selenium (selenomethionine)',
            dosage: '200 mcg/dag',
            timing: 'Bij maaltijd',
            reason: 'Selenium essentieel voor T4→T3 conversie en TPO-verlaging bij Hashimoto',
            duration: '6 maanden',
          },
          message: 'Selenium te laag: voeg Selenomethionine 200 mcg/dag toe — kritisch voor schildklierfunctie.',
        },
      ],
    },
  ],
  MG_RBC: [
    {
      status: 'low',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'increase_supplement',
          supplement: {
            name: 'Magnesium citraat',
            dosage: '400–600 mg/dag',
            timing: 'Avond (bevordert slaap)',
            reason: 'Intracellulair magnesiumtekort — verhoogde dosering noodzakelijk',
            duration: 'Doorlopend',
          },
          message: 'Magnesium (RBC) te laag: verhoog naar 400-600 mg/dag. Stress en intensief sporten verbruiken magnesium snel.',
        },
      ],
    },
  ],
  CR: [
    {
      status: 'low',
      severity: 'moderate',
      adjustments: [
        {
          severity: 'moderate',
          type: 'add_supplement',
          supplement: {
            name: 'Chromium',
            dosage: '200–400 mcg/dag',
            timing: 'Bij lunchmaaltijd',
            reason: 'Chromium verbetert insulinegevoeligheid — often laag bij suikercravings',
            duration: '3 maanden',
          },
          message: 'Chromium te laag: voeg Chromium 200-400 mcg/dag toe voor betere bloedsuikerregulatie.',
        },
      ],
    },
  ],

  // ── Schildklier ──
  TSH: [
    {
      status: 'high',
      criticalThreshold: 10,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Selenium (selenomethionine)',
            dosage: '200 mcg/dag',
            timing: 'Bij maaltijd',
            reason: 'Ondersteunt T4→T3 conversie en verlaagt TPO-antistoffen',
            duration: '6 maanden',
          },
          message: 'TSH verhoogd: voeg Selenium toe en controleer fT3, fT4 en TPO. Verwijs bij TSH >10 naar huisarts/endocrinoloog.',
        },
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Zink bisglycinaat',
            dosage: '25 mg/dag',
            timing: 'Bij avondmaaltijd',
            reason: 'Zink nodig voor schildklierhormoonsynthese en T3-receptor binding',
            duration: '3 maanden',
          },
          message: '',
        },
        {
          severity: 'significant',
          type: 'referral',
          referralNote: 'Bij TSH > 10 mU/L: verwijs naar huisarts/endocrinoloog voor evaluatie hypothyreoïdie en eventueel medicatiebeleid.',
          message: '',
        },
      ],
    },
    {
      status: 'low',
      severity: 'moderate',
      adjustments: [
        {
          severity: 'moderate',
          type: 'referral',
          referralNote: 'TSH verlaagd: sluit hyperthyreoïdie uit. Verwijs naar huisarts voor controle fT3, fT4.',
          message: 'TSH te laag: controleer op hyperthyreoïdie. Vermijd jodiumsupplementen tot diagnose is gesteld.',
        },
      ],
    },
  ],
  fT3: [
    {
      status: 'low',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Selenium (selenomethionine)',
            dosage: '200 mcg/dag',
            timing: 'Bij maaltijd',
            reason: 'Lage T3 conversie — selenium is cofactor voor deiodinase-enzym',
            duration: '6 maanden',
          },
          message: 'fT3 te laag: vertraagd metabolisme door slechte T4→T3 conversie. Voeg Selenium toe, check rT3.',
        },
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'L-Carnitine',
            dosage: '1000–2000 mg/dag',
            timing: 'Ochtend nuchter',
            reason: 'Lage T3: L-Carnitine ondersteunt vetverbranding als compensatie',
            duration: '3 maanden',
          },
          message: '',
        },
      ],
    },
  ],

  // ── Insuline & metabolisme ──
  INS: [
    {
      status: 'high',
      criticalThreshold: 15,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Berberine',
            dosage: '3x 500 mg/dag',
            timing: 'Bij maaltijden',
            reason: 'Verhoogde insuline: Berberine activeert AMPK — werkt als natuurlijk metformine',
            duration: '3 maanden',
          },
          message: 'Nuchtere insuline te hoog: insulineresistentie bevestigd. Voeg Berberine toe (niet combineren met metformine zonder overleg huisarts) en overweeg koolhydraatrestrictie 50-100g/dag.',
        },
        {
          severity: 'significant',
          type: 'increase_supplement',
          supplement: {
            name: 'Myo-inositol',
            dosage: '2x 2000 mg/dag',
            timing: 'Ochtend + avond bij maaltijd',
            reason: 'Verbetert insulinegevoeligheid op cellulair niveau',
            duration: '6 maanden',
          },
          message: '',
        },
        {
          severity: 'significant',
          type: 'nutrition',
          nutritionChange: 'Koolhydraten beperken tot 50-100 g/dag (laag-glycemisch). Intervalvasten 16:8 overwegen. Azijn voor maaltijden (1 el appelazijn in water).',
          message: '',
        },
      ],
    },
  ],
  HOMA: [
    {
      status: 'high',
      criticalThreshold: 4,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Berberine',
            dosage: '3x 500 mg/dag',
            timing: 'Bij maaltijden',
            reason: 'HOMA-IR verhoogd: insulineresistentie bevestigd — Berberine als eerste keuze',
            duration: '3 maanden',
          },
          message: 'HOMA-IR te hoog: significante insulineresistentie. Voeg Berberine toe. Koolhydraatrestrictie is cruciaal. Bij HOMA >4 overweeg verwijzing huisarts voor metformine evaluatie.',
        },
        {
          severity: 'significant',
          type: 'nutrition',
          nutritionChange: 'Strikt koolhydraatarm: max 50-80 g/dag. Intervalvasten 16:8 of 18:6. Vermijd alle geraffineerde suikers en vruchtensappen.',
          message: '',
        },
      ],
    },
  ],
  HBA1C: [
    {
      status: 'high',
      criticalThreshold: 6.5,
      severity: 'critical',
      adjustments: [
        {
          severity: 'critical',
          type: 'referral',
          referralNote: 'HbA1c ≥ 6.5%: diagnostisch voor diabetes mellitus type 2. Directe verwijzing naar huisarts is noodzakelijk.',
          message: 'HbA1c te hoog (≥ 6.5%): VERWIJZEN naar huisarts. Diabetes protocol starten. Berberine als adjuvant — NIET als vervanging van medische zorg.',
        },
        {
          severity: 'critical',
          type: 'add_supplement',
          supplement: {
            name: 'Berberine',
            dosage: '3x 500 mg/dag',
            timing: 'Bij maaltijden',
            reason: 'Adjuvant bij hoog HbA1c — bloedsuikerverlaging',
            duration: 'In overleg met huisarts',
          },
          message: '',
        },
        {
          severity: 'critical',
          type: 'nutrition',
          nutritionChange: 'Strict koolhydraatarm dieet (<50 g/dag). Geen suiker, geen bewerkte producten. Dagelijkse beweging (30 min wandelen) verplicht als eerste interventie.',
          message: '',
        },
      ],
    },
  ],

  // ── Cortisol & bijnier ──
  CORT: [
    {
      status: 'high',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Ashwagandha (KSM-66)',
            dosage: '2x 300 mg/dag',
            timing: 'Ochtend + avond',
            reason: 'Hoog cortisol: Ashwagandha verlaagt cortisolrespons via HPA-as regulatie',
            duration: '3 maanden',
          },
          message: 'Cortisol te hoog: chronische stress belemmert vetverbranding. Voeg Ashwagandha en Fosfatidylserine toe. Prioriteer slaaphygiëne en stressmanagement.',
        },
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Fosfatidylserine',
            dosage: '300 mg/dag',
            timing: 'Avond (30 min voor slapen)',
            reason: 'Verlaagt avondcortisol en verbetert slaapkwaliteit',
            duration: '2 maanden',
          },
          message: '',
        },
      ],
    },
    {
      status: 'low',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Vitamine C',
            dosage: '1000–2000 mg/dag',
            timing: 'Gespreid over de dag bij maaltijden',
            reason: 'Lage cortisol: bijnierschorsondersteuning — Vitamine C is cofactor voor cortisolsynthese',
            duration: 'Doorlopend',
          },
          message: 'Cortisol te laag: bijnieruitputting mogelijk. Voeg Vit C en B5 toe. Verwijs naar huisarts om Addison uit te sluiten bij ernstig lage waarden.',
        },
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Vitamine B5 (pantotheenzuur)',
            dosage: '200 mg/dag',
            timing: 'Ochtend',
            reason: 'B5 essentieel voor bijnierschorshormoonsynthese',
            duration: '3 maanden',
          },
          message: '',
        },
        {
          severity: 'significant',
          type: 'referral',
          referralNote: 'Cortisol < 250 nmol/L: sluit Addison-ziekte uit. Verwijs naar endocrinoloog of internist.',
          message: '',
        },
      ],
    },
  ],

  // ── Ontsteking ──
  CRP: [
    {
      status: 'high',
      criticalThreshold: 10,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'increase_supplement',
          supplement: {
            name: 'Omega-3 (EPA+DHA)',
            dosage: '3000 mg/dag',
            timing: 'Bij maaltijden (gespreid)',
            reason: 'Verhoogd CRP: hoge dosis omega-3 remt NF-κB ontstekingsroute',
            duration: '3 maanden, daarna retest',
          },
          message: 'hs-CRP te hoog: laaggradige ontsteking aanwezig — verhoog Omega-3 naar 3000 mg/dag en voeg Curcumine toe.',
        },
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Curcumine (met piperine)',
            dosage: '500 mg 2x/dag',
            timing: 'Bij maaltijden',
            reason: 'Anti-inflammatoir — remt TNF-α en IL-6 cytokines',
            duration: '3 maanden',
          },
          message: '',
        },
        {
          severity: 'significant',
          type: 'nutrition',
          nutritionChange: 'Elimineer bewerkte voeding, alcohol en transvetten. Voeg kurkuma, gember en groene groenten toe. Anti-inflammatoir dieet patroon (mediterraan).',
          message: '',
        },
      ],
    },
  ],

  // ── Lipiden ──
  TG: [
    {
      status: 'high',
      criticalThreshold: 4.0,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'increase_supplement',
          supplement: {
            name: 'Omega-3 (EPA+DHA)',
            dosage: '3000–4000 mg/dag',
            timing: 'Bij maaltijden',
            reason: 'Hoge triglyceriden: hoge EPA+DHA verlaagt TG met 20-30%',
            duration: '3 maanden, daarna retest',
          },
          message: 'Triglyceriden te hoog: verhoog Omega-3 naar 3000-4000 mg/dag. Vermijd alcohol en fructose volledig. Koolhydraatrestrictie is cruciaal.',
        },
        {
          severity: 'significant',
          type: 'nutrition',
          nutritionChange: 'Vermijd alcohol, vruchtensappen en alle suikers. Koolhydraten beperken tot max 100 g/dag. Meer vette vis (zalm, makreel 3x/week).',
          message: '',
        },
      ],
    },
  ],

  // ── Darmgezondheid ──
  CALPRO: [
    {
      status: 'high',
      criticalThreshold: 500,
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'L-Glutamine',
            dosage: '5–10 g/dag',
            timing: 'Op nuchtere maag (ochtend en/of avond)',
            reason: 'Verhoogd calprotectine: L-Glutamine herstelt darmepitheel en verlaagt permeabiliteit',
            duration: '3 maanden',
          },
          message: 'Calprotectine te hoog: darmontsteking aanwezig. Bij >500: directe verwijzing MDL-arts. Voeg L-Glutamine en probiotica toe.',
        },
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Probiotica (multi-strain)',
            dosage: '10-20 miljard CFU/dag',
            timing: 'Voor maaltijd of nuchter',
            reason: 'Darmfloraherstel bij inflammatie',
            duration: '3 maanden',
          },
          message: '',
        },
        {
          severity: 'significant',
          type: 'referral',
          referralNote: 'Calprotectine > 200 µg/g: matig-ernstige darmontsteking. Verwijs naar MDL-arts om IBD (Crohn, colitis) uit te sluiten. >500: directe verwijzing.',
          message: '',
        },
      ],
    },
  ],
  ZONULIN: [
    {
      status: 'high',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'L-Glutamine',
            dosage: '5–10 g/dag',
            timing: 'Op nuchtere maag',
            reason: 'Verhoogd zonuline = leaky gut: L-Glutamine herstelt tight junctions',
            duration: '3 maanden',
          },
          message: 'Zonuline te hoog: verhoogde darmpermeabiliteit (leaky gut). Voeg L-Glutamine en Zink-carnosine toe. Overweeg glutenvrij protocol 4-6 weken.',
        },
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Zink-carnosine',
            dosage: '75 mg 2x/dag',
            timing: 'Bij maaltijden',
            reason: 'Beschermt darmmucosa en herstelt darmbarrière',
            duration: '3 maanden',
          },
          message: '',
        },
        {
          severity: 'significant',
          type: 'nutrition',
          nutritionChange: 'Elimineer gluten 4-6 weken (strikte test). Vermijd alcohol. Voeg bone broth, gefermenteerde voeding en groene groenten toe.',
          message: '',
        },
      ],
    },
  ],
  PE1: [
    {
      status: 'low',
      severity: 'significant',
      adjustments: [
        {
          severity: 'significant',
          type: 'add_supplement',
          supplement: {
            name: 'Spijsverteringsenzymen (breed spectrum)',
            dosage: '1–2 capsules bij elke maaltijd',
            timing: 'Direct bij begin van maaltijd',
            reason: 'Verlaagd PE-1: exocriene pancreasinsufficientie — enzymsuppletie voor betere vertering',
            duration: 'Doorlopend, evalueer na 3 maanden',
          },
          message: 'Pancreas Elastase-1 te laag: verminderde enzymaanmaak. Voeg spijsverteringsenzymen toe bij elke maaltijd. Bij PE-1 < 200: verwijs MDL-arts.',
        },
        {
          severity: 'significant',
          type: 'referral',
          referralNote: 'PE-1 < 200 µg/g: matig-ernstige exocriene pancreasinsufficientie. Verwijs naar MDL-arts.',
          message: '',
        },
      ],
    },
  ],
  SIGA: [
    {
      status: 'low',
      severity: 'moderate',
      adjustments: [
        {
          severity: 'moderate',
          type: 'add_supplement',
          supplement: {
            name: 'Saccharomyces boulardii',
            dosage: '500 mg/dag',
            timing: 'Voor maaltijd',
            reason: 'Laag sIgA = verminderde darmimmuunfunctie: S. boulardii stimuleert IgA-productie',
            duration: '3 maanden',
          },
          message: 'Secretoir IgA te laag: verminderde mucosale afweer. Voeg Saccharomyces boulardii en Colostrum toe.',
        },
        {
          severity: 'moderate',
          type: 'add_supplement',
          supplement: {
            name: 'Colostrum',
            dosage: '500 mg 2x/dag',
            timing: 'Op nuchtere maag',
            reason: 'Colostrum stimuleert IgA-productie en versterkt darmbarrière',
            duration: '3 maanden',
          },
          message: '',
        },
      ],
    },
  ],
}

// =====================================================
// Hoofdfunctie
// =====================================================
export function adjustProtocolFromLabResults(
  interpretations: LabInterpretation[]
): ProtocolAdjustment[] {
  const adjustments: ProtocolAdjustment[] = []

  for (const interp of interpretations) {
    if (interp.status === 'optimal') continue

    const rules = RULES[interp.code]
    if (!rules) continue

    for (const rule of rules) {
      if (rule.status !== interp.status) continue

      // Bepaal severity (critical overschrijft significant als drempel gehaald)
      let severity = rule.severity
      if (rule.criticalThreshold !== undefined) {
        if (interp.status === 'low' && interp.value <= rule.criticalThreshold) severity = 'critical'
        if (interp.status === 'high' && interp.value >= rule.criticalThreshold) severity = 'critical'
      }

      // Voeg adjustments toe — sla lege messages over (sub-items)
      for (const adj of rule.adjustments) {
        adjustments.push({
          code: interp.code,
          labName: interp.name,
          labValue: interp.value,
          unit: interp.unit,
          status: interp.status,
          severity,
          ...adj,
        })
      }
    }
  }

  // Sorteer: critical eerst, dan significant, dan moderate
  const severityOrder = { critical: 0, significant: 1, moderate: 2 }
  adjustments.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  return adjustments
}

// =====================================================
// Samenvatting voor UI-weergave
// =====================================================
export interface AdjustmentSummary {
  totalAdjustments: number
  criticalCount: number
  supplementsToAdd: string[]
  supplementsToIncrease: string[]
  referrals: string[]
  nutritionChanges: string[]
  hasUrgentAction: boolean
}

export function summarizeAdjustments(adjustments: ProtocolAdjustment[]): AdjustmentSummary {
  const visible = adjustments.filter(a => a.message !== '')

  return {
    totalAdjustments: visible.length,
    criticalCount: adjustments.filter(a => a.severity === 'critical').length,
    supplementsToAdd: adjustments
      .filter(a => a.type === 'add_supplement' && a.supplement)
      .map(a => a.supplement!.name),
    supplementsToIncrease: adjustments
      .filter(a => a.type === 'increase_supplement' && a.supplement)
      .map(a => a.supplement!.name),
    referrals: adjustments
      .filter(a => a.type === 'referral' && a.referralNote)
      .map(a => a.referralNote!),
    nutritionChanges: adjustments
      .filter(a => a.type === 'nutrition' && a.nutritionChange)
      .map(a => a.nutritionChange!),
    hasUrgentAction: adjustments.some(a => a.severity === 'critical'),
  }
}
