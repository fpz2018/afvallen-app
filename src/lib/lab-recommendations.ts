// =====================================================
// Lab Test Recommendations Engine
// Genereert lab-test pakketten op basis van categorieën
// Inclusief BLOED + ONTLASTING onderzoek
// =====================================================
import { TriageResponses } from './classification'

export interface LabTest {
  name: string
  code: string
  required: boolean
  category: string
  type: 'blood' | 'stool' | 'urine' | 'saliva' | 'other'
  note?: string
  rationale?: string      // Waarom deze test? Klinische motivatie
  timing?: string         // Timing instructies (nuchter, ochtend, etc.)
  specimen?: string       // Materiaal info
}

export interface LabPackage {
  name: string
  tests: LabTest[]
  bloodTests: LabTest[]
  stoolTests: LabTest[]
  otherTests: LabTest[]
  urgency: 'high' | 'medium' | 'low'
  rationale: string
}

// =====================================================
// BASIS BLOEDONDERZOEK (voor elke patiënt)
// =====================================================
const BASE_BLOOD_PACKAGE: LabTest[] = [
  { name: 'TSH', code: 'TSH', required: true, category: 'Schildklier', type: 'blood', timing: 'Ochtend, nuchter', rationale: 'Basisscreening schildklierfunctie - essentieel bij gewichtsproblematiek' },
  { name: 'Vrij T4 (fT4)', code: 'fT4', required: true, category: 'Schildklier', type: 'blood', timing: 'Ochtend, nuchter', rationale: 'Actief schildklierhormoon - samen met TSH voor volledig beeld' },
  { name: 'Glucose (nuchter)', code: 'GLUC', required: true, category: 'Metabolisme', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Nuchtere bloedsuiker - basisscreening insulineresistentie/diabetes' },
  { name: 'HbA1c', code: 'HBA1C', required: true, category: 'Metabolisme', type: 'blood', timing: 'Geen specifieke timing', rationale: 'Gemiddelde bloedsuiker afgelopen 3 maanden - gouden standaard diabetes monitoring' },
  { name: 'Totaal Cholesterol', code: 'CHOL', required: true, category: 'Lipiden', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Lipidenprofiel - cardiovasculair risico bij overgewicht' },
  { name: 'HDL-cholesterol', code: 'HDL', required: true, category: 'Lipiden', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Beschermend cholesterol - laag HDL = verhoogd risico' },
  { name: 'LDL-cholesterol', code: 'LDL', required: true, category: 'Lipiden', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Atherogeen cholesterol - verhoogd bij insulineresistentie' },
  { name: 'Triglyceriden', code: 'TG', required: true, category: 'Lipiden', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Verhoogd bij insulineresistentie, metabol syndroom' },
  { name: 'ALAT (leverfunctie)', code: 'ALAT', required: true, category: 'Lever', type: 'blood', rationale: 'Leverfunctie - uitsluiten leververvetting (NAFLD) bij overgewicht' },
  { name: 'ASAT (leverfunctie)', code: 'ASAT', required: true, category: 'Lever', type: 'blood', rationale: 'Leverfunctie + spierbeschadiging' },
  { name: 'Gamma-GT', code: 'GGT', required: true, category: 'Lever', type: 'blood', rationale: 'Leverfunctie - gevoeligste marker voor leverbelasting' },
  { name: 'Creatinine + eGFR', code: 'CREA', required: true, category: 'Nier', type: 'blood', rationale: 'Nierfunctie - essentieel bij metabool syndroom' },
  { name: 'Hemoglobine (Hb)', code: 'HB', required: true, category: 'Bloed', type: 'blood', rationale: 'Anemie screening - vermoeidheid kan gewichtsverlies belemmeren' },
  { name: 'MCV', code: 'MCV', required: true, category: 'Bloed', type: 'blood', rationale: 'Onderscheid micro/macrocytaire anemie (ijzer vs B12/foliumzuur)' },
  { name: 'Vitamine D (25-OH)', code: 'VITD', required: true, category: 'Vitaminen', type: 'blood', rationale: 'Vitamine D tekort geassocieerd met insulineresistentie en gewichtstoename' },
  { name: 'Ferritine', code: 'FER', required: true, category: 'Mineralen', type: 'blood', rationale: 'IJzervoorraad - laag ferritine = vermoeidheid, belemmert afvallen' },
]

// =====================================================
// BASIS ONTLASTINGSONDERZOEK (bij darmklachten / metabole weerstand)
// =====================================================
const BASE_STOOL_PACKAGE: LabTest[] = [
  { name: 'Calprotectine (feces)', code: 'CALPRO', required: true, category: 'Darm/Ontsteking', type: 'stool', specimen: 'Ontlasting (ochtendportie)', rationale: 'Marker voor darmontsteking - verhoogd bij IBD, leaky gut', timing: 'Eerste ontlasting van de dag' },
  { name: 'Zonuline (feces)', code: 'ZONULIN', required: true, category: 'Darm/Permeabiliteit', type: 'stool', specimen: 'Ontlasting', rationale: 'Marker voor doorlaatbaarheid darmwand (leaky gut) - geassocieerd met obesitas en insulineresistentie', timing: 'Eerste ontlasting van de dag' },
  { name: 'Pancreas Elastase-1 (feces)', code: 'PE1', required: true, category: 'Darm/Vertering', type: 'stool', specimen: 'Ontlasting', rationale: 'Pancreasfunctie - exocriene insufficiëntie kan malabsorptie veroorzaken', timing: 'Eerste ontlasting van de dag' },
  { name: 'sIgA (feces)', code: 'SIGA', required: true, category: 'Darm/Immuniteit', type: 'stool', specimen: 'Ontlasting', rationale: 'Darmimmuunfunctie - laag sIgA = verminderde mucosale afweer, verhoogde gevoeligheid voor infecties', timing: 'Eerste ontlasting van de dag' },
]

// =====================================================
// CATEGORIE-SPECIFIEKE BLOEDTESTEN
// =====================================================
const CATEGORY_BLOOD_TESTS: Record<string, LabTest[]> = {
  metabolic_resistance: [
    { name: 'Vrij T3 (fT3)', code: 'fT3', required: true, category: 'Schildklier', type: 'blood', timing: 'Ochtend, nuchter', rationale: 'T4→T3 conversie beoordelen - lage conversie remt metabolisme' },
    { name: 'Insuline (nuchter)', code: 'INS', required: true, category: 'Metabolisme', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Directe meting insulineresistentie - vaak verhoogd vóór glucose stijgt' },
    { name: 'HOMA-IR (berekend)', code: 'HOMA', required: true, category: 'Metabolisme', type: 'blood', timing: 'Berekend uit glucose + insuline', rationale: 'Gouden standaard meting insulineresistentie. >2.0 = weerstand' },
    { name: 'Cortisol (ochtend 8:00u)', code: 'CORT', required: true, category: 'Bijnier', type: 'blood', timing: 'Ochtend 8:00-9:00', rationale: 'Chronisch verhoogd cortisol remt vetverbranding en bevordert abdominaal vet' },
    { name: 'DHEA-S', code: 'DHEAS', required: true, category: 'Bijnier', type: 'blood', rationale: 'Cortisol/DHEA-S ratio geeft bijnierfunctie weer - disbalans remt metabolisme' },
    { name: 'CRP (hs-CRP)', code: 'CRP', required: true, category: 'Ontsteking', type: 'blood', rationale: 'Laaggradige ontsteking bij metabole weerstand - >1.0 mg/L = verhoogd risico' },
    { name: 'Leptine', code: 'LEPT', required: true, category: 'Hormonen', type: 'blood', rationale: 'Leptineresistentie is kernmechanisme bij metabole weerstand - brain ziet "honger" ondanks vetreserves' },
    { name: 'Reverse T3 (rT3)', code: 'rT3', required: false, category: 'Schildklier', type: 'blood', note: 'Bij vermoeden conversieprobleem', rationale: 'Inactief T3 - verhoogd bij stress, diëten. Blokkeert actief T3' },
    { name: 'Homocysteïne', code: 'HCY', required: false, category: 'Metabolisme', type: 'blood', rationale: 'Methyleringsmarker - verhoogd = B12/folaat tekort, cardiovasculair risico' },
    { name: 'Vitamine B12', code: 'B12', required: false, category: 'Vitaminen', type: 'blood', rationale: 'Essentieel voor energiemetabolisme en methylering' },
    { name: 'Zink (plasma)', code: 'ZN', required: false, category: 'Mineralen', type: 'blood', rationale: 'Zink nodig voor schildklierconversie en insulinefunctie' },
    { name: 'Selenium', code: 'SE', required: false, category: 'Mineralen', type: 'blood', rationale: 'Essentieel voor deiodinase-enzym (T4→T3 conversie)' },
    { name: 'Adiponectine', code: 'ADIPO', required: false, category: 'Hormonen', type: 'blood', rationale: 'Anti-inflammatoir adipokine - laag bij obesitas en insulineresistentie' },
  ],
  thyroid: [
    { name: 'Vrij T3 (fT3)', code: 'fT3', required: true, category: 'Schildklier', type: 'blood', timing: 'Ochtend, nuchter', rationale: 'Actief schildklierhormoon - laag fT3 = lage stofwisseling' },
    { name: 'TPO-antistoffen', code: 'TPO', required: true, category: 'Schildklier', type: 'blood', rationale: 'Hashimoto screening - auto-immuun schildklierontsteking is #1 oorzaak hypothyreoïdie' },
    { name: 'Anti-Tg antistoffen', code: 'ATG', required: true, category: 'Schildklier', type: 'blood', rationale: 'Aanvullend op TPO - sommige Hashimoto patiënten alleen Anti-Tg positief' },
    { name: 'Reverse T3 (rT3)', code: 'rT3', required: true, category: 'Schildklier', type: 'blood', rationale: 'Conversieprobleem detecteren - hoge rT3 = actief T3 wordt geblokkeerd' },
    { name: 'Selenium', code: 'SE', required: true, category: 'Mineralen', type: 'blood', rationale: 'Essentieel voor deiodinase (T4→T3) en TPO-verlaging bij Hashimoto' },
    { name: 'Zink (plasma)', code: 'ZN', required: true, category: 'Mineralen', type: 'blood', rationale: 'Nodig voor T3-receptor binding en schildklierhormoonsynthese' },
    { name: 'Jodium (urine)', code: 'IODINE', required: false, category: 'Mineralen', type: 'urine', specimen: 'Ochtendurine', rationale: 'Jodiumstatus - tekort kan hypothyreoïdie veroorzaken (voorzichtig bij Hashimoto)', timing: 'Eerste ochtendurine' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: false, category: 'Mineralen', type: 'blood', rationale: 'Intracellulair magnesium - nodig voor schildklierhormoonsynthese' },
    { name: 'IJzer + transferrine', code: 'FE_TRANS', required: false, category: 'Mineralen', type: 'blood', rationale: 'IJzer nodig voor TPO-enzym (schildklierhormoonproductie)' },
  ],
  hormonal: [
    { name: 'Insuline (nuchter)', code: 'INS', required: true, category: 'Metabolisme', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Insulineresistentie is kernprobleem bij PCOS - 70% van PCOS vrouwen' },
    { name: 'HOMA-IR (berekend)', code: 'HOMA', required: true, category: 'Metabolisme', type: 'blood', rationale: 'Insulineresistentie kwantificeren - stuurt behandelkeuze' },
    { name: 'Testosteron (vrij)', code: 'TESTO', required: true, category: 'Hormonen', type: 'blood', timing: 'Ochtend 8:00-10:00', rationale: 'Verhoogd vrij testosteron = PCOS kernciterium' },
    { name: 'DHEA-S', code: 'DHEAS', required: true, category: 'Hormonen', type: 'blood', rationale: 'Bijnier-androgenen - verhoogd bij 20-30% van PCOS vrouwen' },
    { name: 'LH / FSH ratio', code: 'LH_FSH', required: true, category: 'Hormonen', type: 'blood', timing: 'Dag 3-5 menstruatiecyclus', rationale: 'LH:FSH ratio >2:1 typisch voor PCOS' },
    { name: 'Progesteron (dag 21)', code: 'PROG', required: true, category: 'Hormonen', type: 'blood', note: 'Luteale fase', timing: 'Dag 21 van cyclus (of 7 dagen voor verwachte menstruatie)', rationale: 'Ovulatie bevestiging - anovulatie is hoofdoorzaak gewichtstoename bij PCOS' },
    { name: 'SHBG', code: 'SHBG', required: true, category: 'Hormonen', type: 'blood', rationale: 'Laag SHBG = meer vrij testosteron + insulineresistentie marker' },
    { name: 'Oestradiol', code: 'E2', required: false, category: 'Hormonen', type: 'blood', timing: 'Dag 3-5 cyclus (of willekeurig bij postmenopauze)', rationale: 'Oestrogeenstatus - relevant bij menopauze-gerelateerd gewicht' },
    { name: 'Prolactine', code: 'PRL', required: false, category: 'Hormonen', type: 'blood', rationale: 'Verhoogd prolactine kan gewichtstoename en amenorroe veroorzaken' },
    { name: 'AMH', code: 'AMH', required: false, category: 'Hormonen', type: 'blood', note: 'Geen timing vereist', rationale: 'Ovariële reserve + PCOS indicator (verhoogd bij PCOS)' },
  ],
  cortisol: [
    { name: 'Cortisol (ochtend 8:00u)', code: 'CORT', required: true, category: 'Bijnier', type: 'blood', timing: 'Ochtend 8:00-9:00', rationale: 'Piek cortisol meting - te hoog = chronische stress, te laag = bijnieruitputting' },
    { name: 'DHEA-S', code: 'DHEAS', required: true, category: 'Bijnier', type: 'blood', rationale: 'DHEA-S:cortisol ratio bepaalt bijnierfase (alarm vs uitputting)' },
    { name: 'Cortisol/DHEA-S ratio', code: 'CORT_RATIO', required: true, category: 'Bijnier', type: 'blood', rationale: 'Verhoogde ratio = katabool milieu → spierafbraak, vetopslag buik' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: true, category: 'Mineralen', type: 'blood', rationale: 'Stress verbruikt magnesium snel - tekort versterkt stressrespons (vicieuze cirkel)' },
    { name: 'Vitamine B-complex', code: 'BCOMPLEX', required: true, category: 'Vitaminen', type: 'blood', rationale: 'B-vitaminen essentieel voor bijnierfunctie en neurotransmitterproductie' },
    { name: 'CRP (hs-CRP)', code: 'CRP', required: true, category: 'Ontsteking', type: 'blood', rationale: 'Chronische stress verhoogt systemische ontsteking' },
    { name: '4-punts cortisol dagcurve', code: 'CORT_4P', required: false, category: 'Bijnier', type: 'saliva', specimen: 'Speeksel (4x per dag)', note: 'Speekseltest - thuisafname', timing: 'Ochtend (8u), middag (12u), late middag (16u), avond (22u)', rationale: 'Volledige cortisol dagcurve - identificeert timing van disregulatie' },
    { name: 'Melatonine (speeksel)', code: 'MELAT', required: false, category: 'Slaap', type: 'saliva', note: 'Bij slaapproblemen', timing: 'Avond voor slapen (22:00)', rationale: 'Cortisol-melatonine as - verstoorde melatonine versterkt cortisolprobleem' },
  ],
  insulin: [
    { name: 'Insuline (nuchter)', code: 'INS', required: true, category: 'Metabolisme', type: 'blood', timing: 'Nuchter (12u)', rationale: 'Directe insulinemeting - kern van insuline-gedreven gewichtsproblematiek' },
    { name: 'HOMA-IR (berekend)', code: 'HOMA', required: true, category: 'Metabolisme', type: 'blood', rationale: 'Insulineresistentie score - >2.5 = significante weerstand' },
    { name: 'C-peptide', code: 'CPEP', required: true, category: 'Metabolisme', type: 'blood', timing: 'Nuchter', rationale: 'Endogene insulineproductie meten - onderscheid type 1 vs type 2' },
    { name: 'Triglyceriden/HDL ratio', code: 'TG_HDL', required: true, category: 'Lipiden', type: 'blood', rationale: 'TG/HDL ratio >2 = sterke predictor insulineresistentie' },
    { name: 'Chromium', code: 'CR', required: true, category: 'Mineralen', type: 'blood', rationale: 'Chromium verbetert insulinegevoeligheid - vaak tekort bij suikercravings' },
    { name: 'CRP (hs-CRP)', code: 'CRP', required: true, category: 'Ontsteking', type: 'blood', rationale: 'Insulineresistentie bevordert laaggradige ontsteking' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: false, category: 'Mineralen', type: 'blood', rationale: 'Magnesium verbetert insulinegevoeligheid - 48% van diabetici deficiënt' },
    { name: 'Urinezuur', code: 'URIC', required: false, category: 'Metabolisme', type: 'blood', rationale: 'Verhoogd urinezuur geassocieerd met insulineresistentie en metabool syndroom' },
  ],
  medication: [
    { name: 'CoQ10 (plasma)', code: 'COQ10', required: true, category: 'Supplementen', type: 'blood', note: 'Essentieel bij statinegebruik', rationale: 'Statines remmen CoQ10 productie → spierpijn, vermoeidheid, verminderde vetverbranding' },
    { name: 'CK (creatinekinase)', code: 'CK', required: true, category: 'Spier', type: 'blood', note: 'Bij statinegebruik', rationale: 'Spierbeschadiging door statines detecteren' },
    { name: 'Vitamine B12', code: 'B12', required: true, category: 'Vitaminen', type: 'blood', note: 'Bij metforminegebruik', rationale: 'Metformine verlaagt B12 absorptie - 30% van gebruikers wordt deficiënt' },
    { name: 'Folaat', code: 'FOL', required: true, category: 'Vitaminen', type: 'blood', rationale: 'Folaat + B12 nodig voor methylering en homocysteïne-afbraak' },
    { name: 'Homocysteïne', code: 'HCY', required: true, category: 'Metabolisme', type: 'blood', rationale: 'Verhoogd bij B12/folaat tekort door medicatie - cardiovasculair risicofactor' },
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: true, category: 'Mineralen', type: 'blood', rationale: 'Veel medicijnen depleneren magnesium (PPI, diuretica, metformine)' },
    { name: 'Carnitine (plasma)', code: 'CARN', required: false, category: 'Supplementen', type: 'blood', rationale: 'L-carnitine nodig voor vetzuurtransport - kan verlaagd zijn bij medicatiegebruik' },
  ],
  standard: [
    { name: 'Magnesium (RBC)', code: 'MG_RBC', required: false, category: 'Mineralen', type: 'blood', rationale: 'Subklinisch magnesiumtekort komt veel voor, beïnvloedt metabolisme' },
    { name: 'Zink (plasma)', code: 'ZN', required: false, category: 'Mineralen', type: 'blood', rationale: 'Zinktekort beïnvloedt eetlust en smaak - indirect effect op gewicht' },
    { name: 'Vitamine B12', code: 'B12', required: false, category: 'Vitaminen', type: 'blood', rationale: 'Energiemetabolisme - tekort veroorzaakt vermoeidheid' },
  ],
}

// =====================================================
// CATEGORIE-SPECIFIEKE ONTLASTINGSTESTEN
// =====================================================
const CATEGORY_STOOL_TESTS: Record<string, LabTest[]> = {
  metabolic_resistance: [
    { name: 'Korte-keten vetzuren (SCFA)', code: 'SCFA', required: true, category: 'Darm/Microbioom', type: 'stool', specimen: 'Ontlasting', rationale: 'SCFA (butyraat, propionaat, acetaat) produceren goede darmbacteriën. Laag = dysbiose, verminderde vetverbranding', timing: 'Verse ontlasting, snel verwerken' },
    { name: 'Beta-glucuronidase', code: 'BGLUC', required: true, category: 'Darm/Oestrogeen', type: 'stool', specimen: 'Ontlasting', rationale: 'Verhoogd = oestrogeen wordt gerecirculeerd → oestrogeendominantie → vetopslag' },
    { name: 'Secretoir IgA (sIgA)', code: 'SIGA', required: true, category: 'Darm/Immuniteit', type: 'stool', specimen: 'Ontlasting', rationale: 'Darmimmuunfunctie - laag = verminderde barrièrefunctie, chronische ontsteking' },
    { name: 'Microbioom diversiteitsanalyse', code: 'MICRO_DIV', required: false, category: 'Darm/Microbioom', type: 'stool', specimen: 'Ontlasting', note: 'Uitgebreide analyse via gespecialiseerd lab', rationale: 'Verlaagde diversiteit geassocieerd met obesitas en metabole weerstand' },
  ],
  thyroid: [
    { name: 'Zonuline (feces)', code: 'ZONULIN', required: true, category: 'Darm/Permeabiliteit', type: 'stool', specimen: 'Ontlasting', rationale: 'Leaky gut → auto-immuunactivatie → verslechtert Hashimoto. 60-80% van immuunsysteem in darm' },
    { name: 'Calprotectine (feces)', code: 'CALPRO', required: true, category: 'Darm/Ontsteking', type: 'stool', specimen: 'Ontlasting', rationale: 'Darmontsteking → verhoogde doorlaatbaarheid → moleculaire mimicry schildklier' },
    { name: 'Giardia/Parasietenscreening', code: 'PARASIT', required: false, category: 'Darm/Infectie', type: 'stool', specimen: 'Ontlasting (3x op verschillende dagen)', note: '3 monsters op verschillende dagen', rationale: 'Parasitaire infecties kunnen auto-immuun schildklieraandoeningen triggeren' },
  ],
  hormonal: [
    { name: 'Beta-glucuronidase', code: 'BGLUC', required: true, category: 'Darm/Oestrogeen', type: 'stool', specimen: 'Ontlasting', rationale: 'Estrobolome - verhoogde beta-glucuronidase = oestrogeenrecirculatie → PCOS verergering' },
    { name: 'Korte-keten vetzuren (SCFA)', code: 'SCFA', required: true, category: 'Darm/Microbioom', type: 'stool', specimen: 'Ontlasting', rationale: 'SCFA reguleren darmhormonen (GLP-1, PYY) die eetlust en insuline beïnvloeden' },
    { name: 'Zonuline (feces)', code: 'ZONULIN', required: false, category: 'Darm/Permeabiliteit', type: 'stool', specimen: 'Ontlasting', rationale: 'Leaky gut versterkt systemische ontsteking → verergert hormonale disbalans' },
  ],
  cortisol: [
    { name: 'Calprotectine (feces)', code: 'CALPRO', required: true, category: 'Darm/Ontsteking', type: 'stool', specimen: 'Ontlasting', rationale: 'Stress-darm-as: chronische stress verhoogt darmpermeabiliteit en ontsteking' },
    { name: 'Zonuline (feces)', code: 'ZONULIN', required: true, category: 'Darm/Permeabiliteit', type: 'stool', specimen: 'Ontlasting', rationale: 'Cortisol verhoogt zonuline → leaky gut → systemische ontsteking → meer cortisol (vicieuze cirkel)' },
    { name: 'Secretoir IgA (sIgA)', code: 'SIGA', required: true, category: 'Darm/Immuniteit', type: 'stool', specimen: 'Ontlasting', rationale: 'Chronische stress onderdrukt sIgA → verminderde darmbarrière' },
  ],
  insulin: [
    { name: 'Korte-keten vetzuren (SCFA)', code: 'SCFA', required: true, category: 'Darm/Microbioom', type: 'stool', specimen: 'Ontlasting', rationale: 'Butyraat verbetert insulinegevoeligheid en glucosemetabolisme' },
    { name: 'Zonuline (feces)', code: 'ZONULIN', required: true, category: 'Darm/Permeabiliteit', type: 'stool', specimen: 'Ontlasting', rationale: 'LPS-lekkage door leaky gut → triggert insulineresistentie in lever en spier' },
    { name: 'Candida/Gist screening', code: 'CANDIDA', required: false, category: 'Darm/Infectie', type: 'stool', specimen: 'Ontlasting', rationale: 'Candida overgröei geassocieerd met suikercravings en insulineresistentie' },
  ],
  medication: [
    { name: 'Calprotectine (feces)', code: 'CALPRO', required: true, category: 'Darm/Ontsteking', type: 'stool', specimen: 'Ontlasting', rationale: 'NSAID, PPI en antibiotica kunnen darmontsteking veroorzaken' },
    { name: 'Pancreas Elastase-1 (feces)', code: 'PE1', required: true, category: 'Darm/Vertering', type: 'stool', specimen: 'Ontlasting', rationale: 'Medicatie kan pancreasfunctie beïnvloeden → maldigestie' },
    { name: 'Microbioom diversiteitsanalyse', code: 'MICRO_DIV', required: false, category: 'Darm/Microbioom', type: 'stool', specimen: 'Ontlasting', note: 'Vooral na antibioticagebruik', rationale: 'Antibiotica en PPI verstoren microbioom → metabole gevolgen' },
  ],
  standard: [
    { name: 'Calprotectine (feces)', code: 'CALPRO', required: false, category: 'Darm/Ontsteking', type: 'stool', specimen: 'Ontlasting', rationale: 'Basisscreening darmontsteking bij aanhoudende buikklachten' },
  ],
}

// =====================================================
// RISICOPROFIEL GENERATOR
// =====================================================
export interface RiskProfile {
  overallRisk: 'high' | 'medium' | 'low'
  urgency: 'urgent' | 'moderate' | 'routine'
  urgencyLabel: string
  summary: string
  keyFindings: string[]
  attentionPoints: string[]
  recommendations: string[]
  metabolicSyndromeRisk: boolean
  autoImmuneRisk: boolean
  hormonalComplexity: 'high' | 'medium' | 'low'
}

export function generateRiskProfile(categories: Array<{id: string, risk: string, name: string, triggers: string[]}>, riskScores: Record<string, number>, responses: TriageResponses): RiskProfile {
  const highRiskCount = categories.filter(c => c.risk === 'high').length
  const mediumRiskCount = categories.filter(c => c.risk === 'medium').length
  const totalCategories = categories.length

  // Overall risk
  let overallRisk: 'high' | 'medium' | 'low' = 'low'
  if (highRiskCount >= 2 || (highRiskCount >= 1 && totalCategories >= 3)) overallRisk = 'high'
  else if (highRiskCount >= 1 || mediumRiskCount >= 2) overallRisk = 'medium'

  // Urgency
  let urgency: 'urgent' | 'moderate' | 'routine' = 'routine'
  let urgencyLabel = 'Routine - Standaard protocol'
  if (overallRisk === 'high') {
    urgency = 'urgent'
    urgencyLabel = 'Urgent - Uitgebreid onderzoek nodig'
  } else if (overallRisk === 'medium') {
    urgency = 'moderate'
    urgencyLabel = 'Matig - Gericht onderzoek aanbevolen'
  }

  // Key findings
  const keyFindings: string[] = []
  categories.forEach(cat => {
    cat.triggers.forEach(t => keyFindings.push(t))
  })

  // Attention points
  const attentionPoints: string[] = []
  if (categories.some(c => c.id === 'metabolic_resistance') && categories.some(c => c.id === 'insulin')) {
    attentionPoints.push('Combinatie metabole weerstand + insulineresistentie: sterk verhoogd risico op metabool syndroom')
  }
  if (categories.some(c => c.id === 'thyroid') && categories.some(c => c.id === 'cortisol')) {
    attentionPoints.push('Schildklier + cortisol problematiek: stress remt T4→T3 conversie (vicieuze cirkel)')
  }
  if (categories.some(c => c.id === 'hormonal') && categories.some(c => c.id === 'insulin')) {
    attentionPoints.push('PCOS + insulineresistentie: insuline drijft androgeenproductie → behandel insuline eerst')
  }
  if (categories.some(c => c.id === 'medication')) {
    attentionPoints.push('Medicatie-invloed op metabolisme: check nutriëntdepletie en bijwerkingen')
  }
  if (responses.sleep_quality === 'poor' && responses.stress_frequency === 'daily') {
    attentionPoints.push('Slechte slaap + dagelijkse stress: prioriteer stressreductie vóór andere interventies')
  }
  if (responses.duration_trying === 'over_1_year' && responses.weight_loss_success === 'none') {
    attentionPoints.push('Langdurig falen ondanks inspanningen: onderliggend metabole blokkade waarschijnlijk')
  }
  if (totalCategories >= 3) {
    attentionPoints.push('Multi-categoriaal profiel: integrale aanpak noodzakelijk, niet één factor isoleren')
  }

  // Metabolic syndrome risk
  const metabolicSyndromeRisk = (
    categories.some(c => c.id === 'insulin' || c.id === 'metabolic_resistance') &&
    (responses.fat_distribution === 'belly') &&
    (riskScores['insulin'] >= 4 || riskScores['metabolic_resistance'] >= 4)
  )
  if (metabolicSyndromeRisk) {
    attentionPoints.push('Verhoogd risico op metabool syndroom: buikvet + insulineresistentie. Verwijs voor cardiovasculaire risicobeoordeling')
  }

  // Auto-immune risk
  const autoImmuneRisk = categories.some(c => c.id === 'thyroid') &&
    (responses.diagnosed_conditions?.includes('hashimoto') || responses.diagnosed_conditions?.includes('thyroid'))
  if (autoImmuneRisk) {
    attentionPoints.push('Auto-immuuncomponent aanwezig: focus op darmgezondheid en ontsteking als basis')
  }

  // Hormonal complexity
  let hormonalComplexity: 'high' | 'medium' | 'low' = 'low'
  const hormonalFactors = [
    categories.some(c => c.id === 'hormonal'),
    categories.some(c => c.id === 'thyroid'),
    categories.some(c => c.id === 'cortisol'),
    responses.menopause_status === 'yes',
    responses.medication_use?.includes('thyroid_med'),
  ].filter(Boolean).length
  if (hormonalFactors >= 3) hormonalComplexity = 'high'
  else if (hormonalFactors >= 2) hormonalComplexity = 'medium'

  // Recommendations
  const recommendations: string[] = []
  if (urgency === 'urgent') {
    recommendations.push('Direct uitgebreid bloed- en ontlastingsonderzoek aanvragen')
    recommendations.push('Overweeg verwijzing endocrinoloog/internist bij multi-categoriaal profiel')
  }
  if (metabolicSyndromeRisk) {
    recommendations.push('Prioriteer insulineresistentie behandeling: koolhydraatrestrictie + myo-inositol')
  }
  if (autoImmuneRisk) {
    recommendations.push('Start met darmsanering en leaky gut protocol vóór supplementatie')
  }
  if (categories.some(c => c.id === 'cortisol')) {
    recommendations.push('Stressmanagement en slaaphygiëne als eerste interventie')
  }
  if (categories.some(c => c.id === 'medication')) {
    recommendations.push('Controleer nutriëntdepletie door medicatiegebruik')
  }
  recommendations.push('Lab-onderzoek aanvragen en resultaten beoordelen vóór start supplementprotocol')
  recommendations.push('Follow-up assessment na 6-8 weken behandeling')

  // Summary
  let summary = ''
  if (totalCategories === 1 && categories[0]?.id === 'standard') {
    summary = 'Geen specifieke biochemische beperkende factoren geïdentificeerd. Focus op leefstijl optimalisatie met basis supplementatie.'
  } else {
    const catNames = categories.map(c => c.name).join(', ')
    summary = `${totalCategories} beperkende factor${totalCategories > 1 ? 'en' : ''} geïdentificeerd: ${catNames}. `
    if (overallRisk === 'high') summary += 'Dit is een complex profiel dat uitgebreid onderzoek en een integrale aanpak vereist.'
    else if (overallRisk === 'medium') summary += 'Gericht aanvullend onderzoek wordt aanbevolen om de behandeling te personaliseren.'
    else summary += 'Gericht onderzoek kan de behandeling verder optimaliseren.'
  }

  return {
    overallRisk,
    urgency,
    urgencyLabel,
    summary,
    keyFindings,
    attentionPoints,
    recommendations,
    metabolicSyndromeRisk,
    autoImmuneRisk,
    hormonalComplexity,
  }
}

// =====================================================
// MAIN FUNCTION: Lab Recommendations
// =====================================================
export function getLabRecommendations(categoryIds: string[], responses?: Partial<TriageResponses>): LabPackage {
  const bloodMap = new Map<string, LabTest>()
  const stoolMap = new Map<string, LabTest>()
  const otherMap = new Map<string, LabTest>()

  function addTest(test: LabTest, map: Map<string, LabTest>) {
    const existing = map.get(test.code)
    if (!existing) {
      map.set(test.code, test)
    } else if (test.required && !existing.required) {
      map.set(test.code, { ...existing, required: true, rationale: test.rationale || existing.rationale })
    }
  }

  // Add base blood package
  for (const test of BASE_BLOOD_PACKAGE) {
    addTest(test, bloodMap)
  }

  // Add category-specific blood tests
  for (const catId of categoryIds) {
    const catTests = CATEGORY_BLOOD_TESTS[catId] || []
    for (const test of catTests) {
      if (test.type === 'blood') addTest(test, bloodMap)
      else if (test.type === 'urine' || test.type === 'saliva') addTest(test, otherMap)
    }
  }

  // Add stool tests: always base if non-standard, plus category-specific
  const isNonStandard = categoryIds.some(id => id !== 'standard')
  if (isNonStandard) {
    for (const test of BASE_STOOL_PACKAGE) {
      addTest(test, stoolMap)
    }
  }

  for (const catId of categoryIds) {
    const catStoolTests = CATEGORY_STOOL_TESTS[catId] || []
    for (const test of catStoolTests) {
      addTest(test, stoolMap)
    }
  }

  // Sort tests
  const sortTests = (tests: LabTest[]) => {
    return tests.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1
      return a.category.localeCompare(b.category)
    })
  }

  const bloodTests = sortTests(Array.from(bloodMap.values()))
  const stoolTests = sortTests(Array.from(stoolMap.values()))
  const otherTests = sortTests(Array.from(otherMap.values()))
  const allTests = [...bloodTests, ...stoolTests, ...otherTests]

  // Determine urgency
  let urgency: 'high' | 'medium' | 'low' = 'low'
  if (categoryIds.length >= 3 || categoryIds.includes('metabolic_resistance')) urgency = 'high'
  else if (categoryIds.length >= 2) urgency = 'medium'

  // Package name & rationale
  let rationale = ''
  if (categoryIds.length > 1) {
    rationale = `Multi-categoriaal profiel (${categoryIds.length} factoren) → uitgebreid bloed- en ontlastingsonderzoek noodzakelijk voor gerichte behandeling.`
  } else if (categoryIds[0] === 'standard') {
    rationale = 'Basis screening om subklinische tekorten uit te sluiten.'
  } else {
    rationale = `Gericht onderzoek op ${categoryIds[0]} → specifieke markers aangevraagd voor diagnose en behandelplan.`
  }

  return {
    name: categoryIds.length > 1
      ? `Uitgebreid pakket: ${categoryIds.join(' + ')}`
      : categoryIds[0] || 'Basis pakket',
    tests: allTests,
    bloodTests,
    stoolTests,
    otherTests,
    urgency,
    rationale,
  }
}

// =====================================================
// Lab Result Interpretation (BLOED + ONTLASTING)
// =====================================================

export interface LabReference {
  code: string
  name: string
  optimalMin: number
  optimalMax: number
  unit: string
  type: 'blood' | 'stool' | 'urine' | 'saliva'
  lowAlert: string
  highAlert: string
  lowActions: string[]
  highActions: string[]
}

export const LAB_REFERENCES: LabReference[] = [
  // === BLOED ===
  {
    // Orthomoleculair optimaal: 0.4–2.0 mU/L (Pruimboom); streef laag-normaal, >2.5 = subklinisch hypothyreoïdie
    code: 'TSH', name: 'TSH', optimalMin: 0.4, optimalMax: 2.0, unit: 'mU/L', type: 'blood',
    lowAlert: 'Mogelijk hyperthyreoïdie',
    highAlert: 'Mogelijk hypothyreoïdie - metabolisme vertraagd',
    lowActions: ['Verwijs endocrinoloog', 'Check fT3, fT4'],
    highActions: ['Check fT3, fT4, TPO', 'Verwijs huisarts', 'Start Se 200µg + Zn 25mg']
  },
  {
    // Orthomoleculair optimaal: 3.6–6.5 pmol/L (Pruimboom); actief schildklierhormoon
    code: 'fT3', name: 'Vrij T3', optimalMin: 3.6, optimalMax: 6.5, unit: 'pmol/L', type: 'blood',
    lowAlert: 'Lage T3 conversie - vertraagd metabolisme',
    highAlert: 'Verhoogd fT3',
    lowActions: ['Check rT3', 'Start selenium 200µg', 'L-carnitine 1000mg', 'Zink 25mg'],
    highActions: ['Verwijs endocrinoloog']
  },
  {
    // Orthomoleculair optimaal: 12–25 pmol/L (OrthoKennis); hogere ondergrens dan standaard
    code: 'fT4', name: 'Vrij T4', optimalMin: 12, optimalMax: 25, unit: 'pmol/L', type: 'blood',
    lowAlert: 'Laag fT4 - schildklier produceert onvoldoende', highAlert: 'Hoog fT4 - overproductie',
    lowActions: ['Check TSH, TPO', 'Evalueer schildklierfunctie', 'Verwijs bij TSH >4.0'],
    highActions: ['Verwijs endocrinoloog']
  },
  {
    code: 'INS', name: 'Insuline (nuchter)', optimalMin: 2, optimalMax: 6, unit: 'mU/L', type: 'blood',
    lowAlert: '', highAlert: 'Insulineresistentie - centrale blokkade vetverbranding',
    lowActions: [],
    highActions: ['Bereken HOMA-IR', 'Koolhydraatrestrictie 50-100g/dag', 'Myo-inositol 2000-4000mg', 'Chromium 200-400µg', 'Overweeg metformine (huisarts)']
  },
  {
    code: 'HOMA', name: 'HOMA-IR', optimalMin: 0.5, optimalMax: 2.0, unit: '', type: 'blood',
    lowAlert: '', highAlert: 'Insulineresistentie bevestigd',
    lowActions: [],
    highActions: ['Koolhydraatrestrictie (50-100g/dag)', 'Intervalvasten 16:8', 'Myo-inositol 2000-4000mg', 'Chromium 200-400µg', 'Berberine 500mg 2x/dag (alternatief metformine)']
  },
  {
    code: 'CORT', name: 'Cortisol (ochtend)', optimalMin: 250, optimalMax: 700, unit: 'nmol/L', type: 'blood',
    lowAlert: 'Lage cortisol - bijnieruitputting (fase 3)',
    highAlert: 'Verhoogd cortisol - chronische stress',
    lowActions: ['Bijnierondersteuning: Vit C 1000mg, B5 200mg', 'Ashwagandha 2x300mg', 'Verwijs endocrinoloog (uitsluiten Addison)', 'Rust en herstel prioriteren'],
    highActions: ['Stressmanagement protocol', 'Fosfatidylserine 300mg voor slapen', 'Ashwagandha 2x300mg', 'Magnesium bisglycinaat 400mg', 'Check slaap, werk-stress']
  },
  {
    code: 'FER', name: 'Ferritine', optimalMin: 30, optimalMax: 100, unit: 'µg/L', type: 'blood',
    lowAlert: 'IJzerdeficiëntie - vermoeidheid belemmert afvallen',
    highAlert: 'Verhoogd ferritine (ontsteking of ijzerstapeling)',
    lowActions: ['IJzerbisglyceinaat 25-50mg/dag', 'Vitamine C 500mg bij inname', 'Lege maag of met OJ'],
    highActions: ['Uitsluiten hemochromatose (HFE-gen)', 'Check CRP, leverfunctie', 'Uitsluiten chronische ontsteking']
  },
  {
    // Orthomoleculair optimaal: 75–150 nmol/L (OrthoKennis); <75 = deficiënt, >250 = toxiciteitsrisico
    code: 'VITD', name: 'Vitamine D', optimalMin: 75, optimalMax: 150, unit: 'nmol/L', type: 'blood',
    lowAlert: 'Vitamine D tekort - insulineresistentie versterkt',
    highAlert: 'Vitamine D te hoog - check calcium',
    lowActions: ['Start 4000 IE/dag (of 50.000 IE/week bij <30 nmol/L)', 'Neem met vetrijke maaltijd', 'Retest na 3 maanden'],
    highActions: ['Stop suppletie bij >250 nmol/L', 'Check calcium', 'Retest na 4 weken']
  },
  {
    code: 'COQ10', name: 'CoQ10', optimalMin: 0.5, optimalMax: 1.5, unit: 'µmol/L', type: 'blood',
    lowAlert: 'CoQ10 deficiëntie - mitochondriën onderpresteren',
    highAlert: '',
    lowActions: ['Ubiquinol 200-300mg/dag', 'Bij statinegebruik: minimaal 200mg', 'Neem met vetrijke maaltijd'],
    highActions: []
  },
  {
    // Orthomoleculair optimaal: 22–36 mmol/mol (OrthoKennis) ≈ 4.1–5.4%; >46 mmol/mol = diabetes
    code: 'HBA1C', name: 'HbA1c', optimalMin: 4.0, optimalMax: 5.4, unit: '%', type: 'blood',
    lowAlert: '', highAlert: 'Prediabetes/diabetes - chronisch verhoogde bloedsuiker',
    lowActions: [],
    highActions: ['5.5-6.4%: prediabetes protocol', 'Koolhydraatrestrictie + berberine 500mg 2x/dag', '>6.5%: verwijs huisarts (diabetes)']
  },
  {
    // Orthomoleculair optimaal: <3 mg/L (OrthoKennis); 3–10 = LGI; >10 = auto-immuun/viraal; >40 = bacterieel
    code: 'CRP', name: 'hs-CRP', optimalMin: 0, optimalMax: 3.0, unit: 'mg/L', type: 'blood',
    lowAlert: '', highAlert: 'Laaggradige ontsteking - belemmert vetverbranding',
    lowActions: [],
    highActions: ['3-10 mg/L: LGI → Omega-3 2000mg EPA+DHA, curcumine 500mg, anti-inflammatoir dieet', '10-40 mg/L: auto-immuun/viraal → uitgebreid onderzoek', '>40 mg/L: infectie → verwijs huisarts']
  },
  {
    code: 'LEPT', name: 'Leptine', optimalMin: 4, optimalMax: 15, unit: 'ng/mL', type: 'blood',
    lowAlert: 'Laag leptine - echte honger, niet leptineresistent',
    highAlert: 'Leptineresistentie - brein registreert geen verzadiging',
    lowActions: ['Check calorie-inname', 'Niet te agressief diëten'],
    highActions: ['Anti-inflammatoir dieet (leptineresistentie is ontsteking-gedreven)', 'Omega-3 hoge dosering', 'Slaap optimaliseren (7-9u)', 'Intervalvasten (verlaagt leptine)']
  },
  {
    // Orthomoleculair optimaal: ≥250 pmol/L (Pruimboom); 148–250 = grijze zone → test MMA/Holo-TC
    code: 'B12', name: 'Vitamine B12', optimalMin: 250, optimalMax: 900, unit: 'pmol/L', type: 'blood',
    lowAlert: 'B12 tekort - vermoeidheid, neurologisch risico; 148-250 pmol/L = grijze zone → test MMA',
    highAlert: '',
    lowActions: ['Methylcobalamine 1000-5000µg sublinguaal', 'Check homocysteïne + MMA bij 148-250 pmol/L', 'Bij metformine: altijd suppleren'],
    highActions: []
  },
  {
    // Orthomoleculair optimaal: <10 µmol/L (ideaal <7-8); verhoogd = methyleringsdefect
    code: 'HCY', name: 'Homocysteïne', optimalMin: 5, optimalMax: 10, unit: 'µmol/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Verhoogd homocysteïne - methyleringsdefect + cardiovasculair/neurodegeneratief risico',
    lowActions: [],
    highActions: ['Methylfolaat 400-800µg', 'Methylcobalamine 1000µg', 'B6 (P5P) 25-50mg', 'Retest na 3 maanden']
  },
  {
    code: 'MG_RBC', name: 'Magnesium (RBC)', optimalMin: 2.0, optimalMax: 2.6, unit: 'mmol/L', type: 'blood',
    lowAlert: 'Magnesiumtekort - versterkt insulineresistentie en stress',
    highAlert: '',
    lowActions: ['Magnesium bisglycinaat 400-600mg/dag', 'Avond innemen (slaapkwaliteit)', 'Magnesiumrijke voeding: noten, zaden, bladgroente'],
    highActions: []
  },

  // === BLOED — METABOLISME & LIPIDEN ===
  {
    // Orthomoleculair: >5.6 = signaal voor leefstijlinterventie; >7.0 = diabetes
    code: 'GLUC', name: 'Glucose (nuchter)', optimalMin: 4.4, optimalMax: 5.6, unit: 'mmol/L', type: 'blood',
    lowAlert: 'Hypoglykemie - check maaltijdpatroon en insuline',
    highAlert: 'Verhoogde nuchtere glucose - insulineresistentie/prediabetes',
    lowActions: ['Check maaltijdfrequentie', 'Overweeg insulinemeting'],
    highActions: ['5.6-7.0: prediabetes → intervalvasten, koolhydraatrestrictie', '>7.0: verwijs huisarts (diabetes)', 'Berberine 500mg 2x/dag overwegen']
  },
  {
    // Orthomoleculair: <1.7 mmol/L functioneel optimaal; hoge TG = koolhydraatintolerantie
    code: 'TG', name: 'Triglyceriden', optimalMin: 0.34, optimalMax: 1.7, unit: 'mmol/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Hoge triglyceriden - koolhydraatintolerantie of leververvetting',
    lowActions: [],
    highActions: ['Koolhydraatrestrictie (<100g/dag)', 'Omega-3 2000mg EPA+DHA', 'Intervalvasten', 'Check HOMA-IR en leverwaarden']
  },
  {
    // Orthomoleculair: >1.5 mmol/L optimaal (OrthoKennis strengere streefwaarde)
    code: 'HDL', name: 'HDL-cholesterol', optimalMin: 1.5, optimalMax: 99, unit: 'mmol/L', type: 'blood',
    lowAlert: 'Laag HDL - verhoogd cardiovasculair en metabolisch risico',
    highAlert: '',
    lowActions: ['Omega-3 2000mg EPA+DHA', 'Matige aerobe beweging (≥150 min/week)', 'Stoppen met roken', 'Verminder geraffineerde koolhydraten']
  },
  {
    // OrthoKennis: <3.0 mmol/L traditionele risicomarker
    code: 'LDL', name: 'LDL-cholesterol', optimalMin: 0, optimalMax: 3.0, unit: 'mmol/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Verhoogd LDL - cardiovasculair risico; check TG/HDL ratio voor partikelgrootte',
    lowActions: [],
    highActions: ['Anti-inflammatoir dieet', 'Check TG/HDL ratio (small dense LDL bij hoge TG)', 'Bij >5.0: verwijs huisarts', 'Bij >8.0: uitsluiten familiaire hypercholesterolemie']
  },
  {
    // OrthoKennis: <5.0 mmol/L optimaal; >8.0 = mogelijk FH
    code: 'CHOL', name: 'Totaal Cholesterol', optimalMin: 0, optimalMax: 5.0, unit: 'mmol/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Verhoogd totaal cholesterol - gebruik ratio\'s (TC/HDL, TG/HDL) voor risicobepaling',
    lowActions: [],
    highActions: ['Bereken TC/HDL ratio (streef <3.6)', 'Anti-inflammatoir dieet', 'Bij >8.0: uitsluiten FH']
  },

  // === BLOED — LEVER ===
  {
    // Orthomoleculair: <50 U/L (Pruimboom); gevoeligste specifieke levermarker
    code: 'ALAT', name: 'ALAT (leverfunctie)', optimalMin: 0, optimalMax: 50, unit: 'U/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Verhoogd ALAT - leverbelasting of leververvetting (NAFLD)',
    lowActions: [],
    highActions: ['Check ASAT en GGT', 'Fatty Liver Index berekenen (BMI + tailleomtrek + TG + GGT)', 'Elimineer alcohol, fructose, verwerkt voedsel', 'Choline 500mg, NAC 600mg overwegen']
  },
  {
    // Standaard: <35 U/L; verhoogd bij levercel- of spierschade
    code: 'ASAT', name: 'ASAT (leverfunctie)', optimalMin: 0, optimalMax: 35, unit: 'U/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Verhoogd ASAT - lever- of spierschade',
    lowActions: [],
    highActions: ['Check ALAT (ASAT/ALAT ratio <2 = lever; >2 = alcohol of spier)', 'Bij CK normaal: lever als oorzaak']
  },
  {
    // Orthomoleculair: <60 U/L (Pruimboom); gevoeligste marker voor galstuwing en oxidatieve stress
    code: 'GGT', name: 'Gamma-GT', optimalMin: 0, optimalMax: 60, unit: 'U/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Verhoogd GGT - galstuwing, alcohol, oxidatieve stress (glutathion-verbruik)',
    lowActions: [],
    highActions: ['Elimineer alcohol', 'NAC 600mg 2x/dag (glutathion-precursor)', 'Check ALAT, bilirubine', 'Anti-oxidant protocol overwegen']
  },
  {
    // Standaard: 40–130 U/L; galwegen of botombouw
    code: 'ALP', name: 'ALP (Alkalische Fosfatase)', optimalMin: 40, optimalMax: 130, unit: 'U/L', type: 'blood',
    lowAlert: 'Laag ALP - mogelijk zink- of magnesiumtekort',
    highAlert: 'Hoog ALP - galweg- of botproblematiek',
    lowActions: ['Check zink en magnesium'],
    highActions: ['Check GGT (galwegen) en botmarkers', 'Verwijs bij persistent verhoogd']
  },

  // === BLOED — NIER & BLOED ===
  {
    code: 'CREA', name: 'Creatinine + eGFR', optimalMin: 50, optimalMax: 110, unit: 'µmol/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Verhoogd creatinine - nierfunctie controleren (eGFR <60 = nierschade)',
    lowActions: [],
    highActions: ['Bereken eGFR', 'Bij eGFR <60: verwijs huisarts', 'Hydratatie optimaliseren']
  },
  {
    code: 'HB', name: 'Hemoglobine', optimalMin: 7.5, optimalMax: 10.5, unit: 'mmol/L', type: 'blood',
    lowAlert: 'Anemie - vermoeidheid belemmert gewichtsverlies',
    highAlert: '',
    lowActions: ['Check ferritine, MCV, B12 en folaat', 'Microcytair (MCV<80): ijzertekort', 'Macrocytair (MCV>100): B12/folaat'],
    highActions: []
  },
  {
    code: 'MCV', name: 'MCV', optimalMin: 80, optimalMax: 100, unit: 'fL', type: 'blood',
    lowAlert: 'Microcytaire anemie - ijzertekort',
    highAlert: 'Macrocytaire anemie - B12 of folaat tekort',
    lowActions: ['Check ferritine, transferrine', 'IJzerbisglyceinaat 25-50mg'],
    highActions: ['Check B12, folaat, homocysteïne', 'Methylcobalamine suppletie']
  },

  // === BLOED — MINERALEN ===
  {
    // Orthomoleculair: plasma 10–18 µmol/L (Pruimboom & OrthoKennis overlap)
    code: 'ZN', name: 'Zink (plasma)', optimalMin: 10, optimalMax: 18, unit: 'µmol/L', type: 'blood',
    lowAlert: 'Zinktekort - beïnvloedt schildklier, immuun en insulinefunctie',
    highAlert: '',
    lowActions: ['Zink bisglycinaat 25mg/dag', 'Neem niet tegelijk met ijzer', 'Voedingsbronnen: pompoenpitten, vlees, schaal- en schelpdieren'],
    highActions: []
  },

  // === BLOED — VITAMINEN ===
  {
    // Orthomoleculair: 10–42.4 nmol/L (Pruimboom); noodzakelijk voor homocysteïneafbraak
    code: 'FOL', name: 'Folaat (B11)', optimalMin: 10, optimalMax: 42.4, unit: 'nmol/L', type: 'blood',
    lowAlert: 'Folaattekort - methylering en DNA-synthese gestoord',
    highAlert: '',
    lowActions: ['Methylfolaat 400-800µg/dag', 'Check homocysteïne en B12', 'Bladgroenten verhogen in dieet'],
    highActions: []
  },

  // === BLOED — IJZERSTATUS ===
  {
    // OrthoKennis: 15–45% (NIEUW); >55% = hemochromatose
    code: 'TSAT', name: 'Transferrinesaturatie', optimalMin: 15, optimalMax: 45, unit: '%', type: 'blood',
    lowAlert: 'Lage transferrinesaturatie - functioneel ijzertekort (ook bij normaal ferritine)',
    highAlert: 'Hoge transferrinesaturatie - mogelijke ijzerstapeling of hemochromatose',
    lowActions: ['Combineer met ferritine en Hb', 'IJzersuppletie indien ook ferritine <30'],
    highActions: ['Bij >55%: uitsluiten hemochromatose (HFE-gen)', 'Verwijs huisarts']
  },
  {
    // OrthoKennis: 2–4 g/L; stijgt bij ijzertekort
    code: 'TRANSF', name: 'Transferrine', optimalMin: 2, optimalMax: 4, unit: 'g/L', type: 'blood',
    lowAlert: '',
    highAlert: 'Hoog transferrine - compensatie voor ijzertekort',
    lowActions: [],
    highActions: ['Combineer met ferritine en TSat']
  },

  // === ONTLASTING ===
  {
    code: 'CALPRO', name: 'Calprotectine (feces)', optimalMin: 0, optimalMax: 50, unit: 'µg/g', type: 'stool',
    lowAlert: '',
    highAlert: 'Darmontsteking - leaky gut, IBD, dysbiose',
    lowActions: [],
    highActions: ['50-200: milde ontsteking → L-glutamine 5g, probiotica', '200-500: matige ontsteking → verwijs MDL-arts', '>500: ernstig → uitsluiten IBD, verwijs direct']
  },
  {
    code: 'ZONULIN', name: 'Zonuline (feces)', optimalMin: 0, optimalMax: 107, unit: 'ng/mL', type: 'stool',
    lowAlert: '',
    highAlert: 'Verhoogde darmpermeabiliteit (leaky gut)',
    lowActions: [],
    highActions: ['L-glutamine 5-10g/dag', 'Zink-carnosine 75mg 2x/dag', 'Eliminatie gluten (4-6 weken)', 'Probiotica (Lactobacillus rhamnosus, Saccharomyces boulardii)']
  },
  {
    code: 'PE1', name: 'Pancreas Elastase-1', optimalMin: 200, optimalMax: 10000, unit: 'µg/g', type: 'stool',
    lowAlert: 'Exocriene pancreasinsufficientie - maldigestie',
    highAlert: '',
    lowActions: ['200-300: milde insufficiëntie → spijsverteringsenzymen bij maaltijden', '<200: matig-ernstig → pancreasenzymen + verwijs MDL-arts', 'Bijkomend: betaïne HCl bij maaltijden'],
    highActions: []
  },
  {
    code: 'SIGA', name: 'Secretoir IgA (feces)', optimalMin: 510, optimalMax: 2040, unit: 'µg/mL', type: 'stool',
    lowAlert: 'Verminderde darmimmuunfunctie',
    highAlert: 'Verhoogd - actieve mucosale immuunreactie',
    lowActions: ['Saccharomyces boulardii 500mg/dag', 'Colostrum 500mg 2x/dag', 'L-glutamine 5g/dag', 'Vitamine A 5000 IE/dag'],
    highActions: ['Uitsluiten actieve infectie/parasiet', 'Eliminatiedieet overwegen', 'Check calprotectine']
  },
  {
    code: 'SCFA', name: 'Korte-keten vetzuren (SCFA)', optimalMin: 70, optimalMax: 150, unit: 'µmol/g', type: 'stool',
    lowAlert: 'Verlaagde SCFA - dysbiose, verminderde vetverbranding',
    highAlert: '',
    lowActions: ['Prebiotica: inuline 5-10g/dag', 'Resistente zetmeel (afgekoelde aardappelen/rijst)', 'Vezels verhogen: 30-40g/dag', 'Probiotica met butyraat-producenten'],
    highActions: []
  },
  {
    code: 'BGLUC', name: 'Beta-glucuronidase', optimalMin: 0, optimalMax: 1000, unit: 'U/mL', type: 'stool',
    lowAlert: '',
    highAlert: 'Verhoogd - oestrogeen recycling → oestrogeendominantie',
    lowActions: [],
    highActions: ['Calcium-D-glucaraat 500mg 2x/dag', 'DIM (Diindolylmethaan) 100-200mg/dag', 'Kruisbloemige groenten verhogen', 'Probiotica (Lactobacillus species)']
  },
]

// Map voor O(1) lookups i.p.v. O(n) Array.find() per labresultaat
const LAB_REFERENCES_MAP: Map<string, LabReference> = new Map(LAB_REFERENCES.map(r => [r.code, r]))

export interface LabInterpretation {
  code: string
  name: string
  value: number
  unit: string
  type: 'blood' | 'stool' | 'urine' | 'saliva'
  status: 'optimal' | 'low' | 'high'
  alert: string
  actions: string[]
}

export function interpretLabResults(results: Record<string, number>): LabInterpretation[] {
  const interpretations: LabInterpretation[] = []

  for (const [code, value] of Object.entries(results)) {
    const ref = LAB_REFERENCES_MAP.get(code)
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
      type: ref.type, status, alert, actions
    })
  }

  return interpretations
}
