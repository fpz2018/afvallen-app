# Weight Loss Assessment Web-App

## Project Overzicht
- **Naam**: Weight Loss Assessment Tool
- **Doel**: Intelligente web-applicatie voor het categoriseren van patienten met overgewicht/obesitas, identificeren van metabole beperkende factoren, en genereren van gepersonaliseerde interventieprotocollen
- **Voor**: Marc's Orthomoleculaire Praktijk
- **Tech Stack**: Hono + TypeScript + Tailwind CSS + Chart.js + Supabase

## URLs
- **Preview**: https://3000-ivwhd9ktlpmi0odg58u71-0e616f0a.sandbox.novita.ai
- **Platform**: Cloudflare Pages

## Voltooide Features

### Kern Functionaliteit
- [x] Dashboard met statistieken (actieve patienten, assessments, lab-testen, protocollen)
- [x] Patientenbeheer (aanmaken, bewerken, archiveren)
- [x] Quick Triage Assessment (15 vragen, 5-10 minuten)
- [x] Automatisch categoriserings-algoritme (7 categorieen)
- [x] Risicoprofiel generatie met urgentie-indicatie
- [x] Lab-test aanbevelingen per categorie (bloed + ontlasting + overig)
- [x] Lab-resultaten invoer met automatische interpretatie
- [x] Gepersonaliseerd protocol generatie (supplementen, voeding, leefstijl, medicatie)
- [x] Patientprofiel met alle data overzichtelijk
- [x] Print functionaliteit

### Progressie & Symptomen (NIEUW)
- [x] **7 individuele symptoomscores**: vermoeidheid, slaap, spijsvertering, stemming, pijn, concentratie, honger (schaal 1-10)
- [x] **Gewicht & BMI trendgrafiek** (Chart.js lijndiagram over tijd)
- [x] **Buikomvang & Energie trendgrafiek** (dual-axis chart)
- [x] **Symptoom Radar Chart** (spider/radar diagram van meest recente meting)
- [x] **Symptoom Lijndiagram** (trends van alle 7 symptomen over tijd, met gekleurde lijnen)
- [x] **Uitgebreide datatable** met alle symptoomscores als gekleurde badges
- [x] **Gewichtstrend-pijlen** (verschil t.o.v. vorige meting, groen/rood)

### Lab-resultaat Visualisatie (NIEUW)
- [x] **Visuele range-bars**: gekleurde balkjes die waarden binnen optimale range tonen
- [x] **Trend-pijlen**: vergelijking met vorige lab-ronde (stijgend/dalend icoon)
- [x] **Datum per lab-ronde**: zichtbaar wanneer elk lab-onderzoek is afgenomen

### Follow-up Planning (NIEUW)
- [x] **Follow-up CRUD API**: aanmaken, bijwerken, verwijderen van follow-ups
- [x] **Type-selectie**: Check-in, Meting, Lab-controle, Protocol evaluatie, Anders
- [x] **Status-tracking**: Gepland, Voltooid, Geannuleerd, Gemist
- [x] **Achterstallig-indicator**: oranje badge bij verlopen follow-ups
- [x] **Inline status-wijziging**: direct markeren als voltooid of geannuleerd

## 7 Patientcategorieen
1. **Metabole Weerstand** - Afvallen lukt niet ondanks inspanningen
2. **Schildklier-gedreven** - Moe, koud, droge huid (Hashimoto)
3. **PCOS/Hormonen** - Onregelmatige cyclus, buikvet (vrouwen)
4. **Cortisol-gedreven** - Dagelijkse stress, slechte slaap
5. **Insuline-gedreven** - Suikercravings, honger na maaltijd
6. **Medicatie-gerelateerd** - Statines (CoQ10), antidepressiva
7. **Standaard Leefstijl** - Geen rode vlaggen

## Pagina's & Routes
| Route | Beschrijving |
|---|---|
| `/` | Dashboard - overzicht statistieken en recente patienten |
| `/patients` | Patientenlijst |
| `/new-patient` | Nieuwe patient aanmaken |
| `/triage/:patientId` | Quick Triage vragenlijst (15 vragen) |
| `/results/:patientId/:assessmentId` | Assessment resultaten + categorieen + lab aanbevelingen |
| `/patient/:id` | Volledig patientprofiel met charts, symptomen, follow-ups |
| `/lab-entry/:patientId/:labId` | Lab-resultaten invoeren |
| `/assessment/:patientId/:assessmentId` | Assessment detail (volledige antwoorden) |
| `/protocol/:patientId/:protocolId` | Volledig protocol bekijken |

## API Endpoints
| Method | Route | Beschrijving |
|---|---|---|
| GET | `/api/stats` | Dashboard statistieken |
| GET | `/api/patients` | Alle actieve patienten |
| GET | `/api/patients/:id` | Patient met alle gerelateerde data |
| POST | `/api/patients` | Nieuwe patient aanmaken |
| PATCH | `/api/patients/:id` | Patient updaten |
| DELETE | `/api/patients/:id` | Patient archiveren (soft delete) |
| POST | `/api/assessments` | Nieuwe assessment + auto-classificatie |
| GET | `/api/assessments/:id` | Assessment ophalen |
| GET | `/api/assessments/patient/:patientId` | Alle assessments van patient |
| GET | `/api/lab-tests/:patientId` | Lab-testen voor patient |
| PATCH | `/api/lab-tests/:id/results` | Lab-resultaten invoeren + interpretatie |
| POST | `/api/protocols` | Protocol genereren |
| GET | `/api/protocols/:patientId` | Protocollen voor patient |
| POST | `/api/progress` | Progressie meting + symptoomscores toevoegen |
| GET | `/api/progress/:patientId` | Progressie voor patient |
| GET | `/api/follow-ups/:patientId` | Follow-ups voor patient |
| POST | `/api/follow-ups` | Nieuwe follow-up aanmaken |
| PATCH | `/api/follow-ups/:id` | Follow-up status updaten |
| DELETE | `/api/follow-ups/:id` | Follow-up verwijderen |
| POST | `/api/classify-preview` | Classificatie preview (niet opgeslagen) |

## Data Architectuur
- **Database**: Supabase (PostgreSQL)
- **Tabellen**: patients, assessments, lab_tests, supplement_protocols, progress_tracking, follow_ups
- **RLS**: Geactiveerd met anon + authenticated policies
- **JSONB velden**: responses, categories, risk_scores, supplements, nutrition, lifestyle, symptoms

### Symptom Data Model (progress_tracking.symptoms JSONB)
```json
{
  "fatigue": 7,       // Vermoeidheid (1=ernstig, 10=geen)
  "sleep": 5,         // Slaapkwaliteit
  "digestion": 8,     // Spijsvertering
  "mood": 6,          // Stemming
  "pain": 9,          // Pijn
  "concentration": 4, // Concentratie
  "hunger": 7         // Hongergevoel
}
```

## Database Migratie (BELANGRIJK)

### Follow-ups tabel aanmaken
Voer het bestand `supabase-migration-followups.sql` uit in de Supabase SQL Editor:
1. Ga naar [Supabase Dashboard](https://supabase.com/dashboard)
2. Open je project > SQL Editor
3. Kopieer en plak de inhoud van `supabase-migration-followups.sql`
4. Klik "Run"

### Bestaande tabellen (al aangemaakt)
- `patients` - Patientgegevens
- `assessments` - Triage assessments met classificatie
- `lab_tests` - Lab-aanbevelingen en resultaten
- `supplement_protocols` - Gepersonaliseerde protocollen
- `progress_tracking` - Metingen incl. symptomen (JSONB)
- `follow_ups` - Follow-up planning (**NIEUW - moet nog aangemaakt**)

## Setup Instructies

### 1. Supabase Database
1. Voer `supabase-setup.sql` uit voor basis tabellen
2. Voer `supabase-migration-v2.sql` uit voor extra kolommen
3. Voer `supabase-migration-followups.sql` uit voor follow-ups tabel

### 2. Environment Variables
In `wrangler.jsonc` of `.dev.vars`:
```
SUPABASE_URL=https://jouw-project.supabase.co
SUPABASE_ANON_KEY=jouw-anon-key
```

### 3. Development
```bash
npm run build
npm run dev:sandbox  # of via PM2: pm2 start ecosystem.config.cjs
```

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: Development
- **Last Updated**: 2026-03-10

## Aanbevolen Volgende Stappen
1. Voer `supabase-migration-followups.sql` uit in Supabase SQL Editor
2. Deploy naar Cloudflare Pages productie
3. Overweeg lengte/BMI veld toevoegen aan patients tabel
4. PDF export mogelijkheid voor protocollen
5. E-mail notificaties voor follow-ups
