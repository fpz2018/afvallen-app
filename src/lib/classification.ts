// =====================================================
// Classification Engine
// Automatische categorisering op basis van Quick Triage
// =====================================================

export interface TriageResponses {
  gender: string
  age: number
  duration_trying: string
  weight_loss_success: string
  fatigue_cold_dry: string
  menstrual_regularity: string
  stress_frequency: string
  sleep_quality: string
  medication_use: string[]
  statin_side_effects: string
  hunger_after_meal: string
  fat_distribution: string
  sugar_cravings: string
  menopause_status: string
  diagnosed_conditions: string[]
}

export interface Category {
  id: string
  name: string
  icon: string
  risk: 'high' | 'medium' | 'low'
  color: string
  triggers: string[]
}

export interface ClassificationResult {
  categories: Category[]
  primaryType: string
  riskScores: Record<string, number>
}

export function classifyPatient(responses: TriageResponses): ClassificationResult {
  const categories: Category[] = []
  const riskScores: Record<string, number> = {}

  // 1. METABOLE WEERSTAND
  let metabolicScore = 0
  if (responses.weight_loss_success === 'none') metabolicScore += 3
  if (responses.weight_loss_success === 'barely') metabolicScore += 2
  if (responses.duration_trying === 'over_1_year') metabolicScore += 3
  if (responses.duration_trying === '6_12_months') metabolicScore += 2
  if (responses.hunger_after_meal === 'always') metabolicScore += 2
  if (responses.hunger_after_meal === 'often') metabolicScore += 1
  riskScores['metabolic_resistance'] = metabolicScore

  if (metabolicScore >= 4) {
    categories.push({
      id: 'metabolic_resistance',
      name: 'Metabole Weerstand',
      icon: 'fa-fire',
      risk: metabolicScore >= 6 ? 'high' : 'medium',
      color: 'red',
      triggers: [
        responses.weight_loss_success === 'none' ? 'Geen resultaat ondanks inspanningen' : '',
        responses.duration_trying === 'over_1_year' ? 'Meer dan 1 jaar proberen af te vallen' : '',
        responses.hunger_after_meal === 'always' ? 'Altijd honger na maaltijd' : '',
      ].filter(Boolean)
    })
  }

  // 2. SCHILDKLIER-GEDREVEN
  let thyroidScore = 0
  if (responses.fatigue_cold_dry === 'yes') thyroidScore += 3
  if (responses.fatigue_cold_dry === 'sometimes') thyroidScore += 1
  if (responses.diagnosed_conditions.includes('hashimoto')) thyroidScore += 4
  if (responses.diagnosed_conditions.includes('thyroid')) thyroidScore += 3
  if (responses.weight_loss_success === 'barely' || responses.weight_loss_success === 'none') thyroidScore += 1
  riskScores['thyroid'] = thyroidScore

  if (thyroidScore >= 3) {
    categories.push({
      id: 'thyroid',
      name: 'Schildklier-gedreven',
      icon: 'fa-moon',
      risk: thyroidScore >= 5 ? 'high' : 'medium',
      color: 'indigo',
      triggers: [
        responses.fatigue_cold_dry === 'yes' ? 'Moe, koud, droge huid' : '',
        responses.diagnosed_conditions.includes('hashimoto') ? 'Hashimoto diagnose' : '',
        responses.diagnosed_conditions.includes('thyroid') ? 'Schildklieraandoening' : '',
      ].filter(Boolean)
    })
  }

  // 3. PCOS / HORMONEN (Vrouwen)
  let hormonalScore = 0
  if (responses.gender === 'female') {
    if (responses.menstrual_regularity === 'irregular' || responses.menstrual_regularity === 'no') hormonalScore += 3
    if (responses.diagnosed_conditions.includes('pcos')) hormonalScore += 4
    if (responses.fat_distribution === 'belly') hormonalScore += 1
    if (responses.menopause_status === 'yes') hormonalScore += 2
    if (responses.age >= 45) hormonalScore += 1
  }
  riskScores['hormonal'] = hormonalScore

  if (hormonalScore >= 3) {
    categories.push({
      id: 'hormonal',
      name: 'PCOS / Hormonen',
      icon: 'fa-venus',
      risk: hormonalScore >= 5 ? 'high' : 'medium',
      color: 'pink',
      triggers: [
        responses.menstrual_regularity === 'irregular' ? 'Onregelmatige menstruatiecyclus' : '',
        responses.diagnosed_conditions.includes('pcos') ? 'PCOS diagnose' : '',
        responses.fat_distribution === 'belly' ? 'Buikvet predominant' : '',
        responses.menopause_status === 'yes' ? 'Postmenopauzaal' : '',
      ].filter(Boolean)
    })
  }

  // 4. CORTISOL-GEDREVEN
  let cortisolScore = 0
  if (responses.stress_frequency === 'daily') cortisolScore += 3
  if (responses.stress_frequency === 'weekly') cortisolScore += 1
  if (responses.sleep_quality === 'poor') cortisolScore += 3
  if (responses.sleep_quality === 'moderate') cortisolScore += 1
  if (responses.fat_distribution === 'belly') cortisolScore += 1
  riskScores['cortisol'] = cortisolScore

  if (cortisolScore >= 4) {
    categories.push({
      id: 'cortisol',
      name: 'Cortisol-gedreven',
      icon: 'fa-brain',
      risk: cortisolScore >= 6 ? 'high' : 'medium',
      color: 'orange',
      triggers: [
        responses.stress_frequency === 'daily' ? 'Dagelijkse stress/angst' : '',
        responses.sleep_quality === 'poor' ? 'Slechte slaap' : '',
        responses.fat_distribution === 'belly' ? 'Stressbuik' : '',
      ].filter(Boolean)
    })
  }

  // 5. INSULINE-GEDREVEN
  let insulinScore = 0
  if (responses.hunger_after_meal === 'always') insulinScore += 3
  if (responses.hunger_after_meal === 'often') insulinScore += 2
  if (responses.sugar_cravings === 'daily') insulinScore += 3
  if (responses.sugar_cravings === 'regularly') insulinScore += 2
  if (responses.diagnosed_conditions.includes('diabetes')) insulinScore += 4
  if (responses.fat_distribution === 'belly') insulinScore += 1
  riskScores['insulin'] = insulinScore

  if (insulinScore >= 4) {
    categories.push({
      id: 'insulin',
      name: 'Insuline-gedreven',
      icon: 'fa-candy-cane',
      risk: insulinScore >= 6 ? 'high' : 'medium',
      color: 'red',
      triggers: [
        responses.hunger_after_meal === 'always' ? 'Altijd honger na maaltijd' : '',
        responses.sugar_cravings === 'daily' ? 'Dagelijkse suikercravings' : '',
        responses.diagnosed_conditions.includes('diabetes') ? 'Diabetes type 2 diagnose' : '',
      ].filter(Boolean)
    })
  }

  // 6. MEDICATIE-GERELATEERD
  let medicationScore = 0
  const hasMedication = responses.medication_use.length > 0 && !responses.medication_use.includes('none')
  if (hasMedication) medicationScore += 2
  if (responses.medication_use.includes('statins')) medicationScore += 2
  if (responses.statin_side_effects === 'yes') medicationScore += 2
  if (responses.medication_use.includes('antidepressants')) medicationScore += 2
  if (responses.medication_use.includes('thyroid_med')) medicationScore += 1
  if (responses.medication_use.includes('diabetes_med')) medicationScore += 1
  riskScores['medication'] = medicationScore

  if (medicationScore >= 3) {
    categories.push({
      id: 'medication',
      name: 'Medicatie-gerelateerd',
      icon: 'fa-pills',
      risk: medicationScore >= 5 ? 'high' : 'medium',
      color: 'blue',
      triggers: [
        responses.medication_use.includes('statins') ? 'Statinegebruik' : '',
        responses.statin_side_effects === 'yes' ? 'Spierpijn bij statines (CoQ10)' : '',
        responses.medication_use.includes('antidepressants') ? 'Antidepressiva gebruik' : '',
        responses.medication_use.includes('diabetes_med') ? 'Diabetesmedicatie' : '',
      ].filter(Boolean)
    })
  }

  // 7. STANDAARD LEEFSTIJL (fallback)
  if (categories.length === 0) {
    categories.push({
      id: 'standard',
      name: 'Standaard Leefstijl',
      icon: 'fa-dumbbell',
      risk: 'low',
      color: 'green',
      triggers: [
        'Geen rode vlaggen gedetecteerd',
        'Focus: voeding + beweging + basis suppletie',
      ]
    })
    riskScores['standard'] = 1
  }

  // Determine primary type
  let primaryType = categories[0]?.id || 'standard'
  let maxScore = 0
  for (const [key, score] of Object.entries(riskScores)) {
    if (score > maxScore) {
      maxScore = score
      primaryType = key
    }
  }

  return { categories, primaryType, riskScores }
}
