# Weight Loss Assessment Web-App

## Project Overzicht
- **Naam**: Weight Loss Assessment Tool
- **Doel**: Intelligente web-applicatie voor het categoriseren van patienten met overgewicht/obesitas, identificeren van metabole beperkende factoren, en genereren van gepersonaliseerde interventieprotocollen
- **Voor**: Marc's Orthomoleculaire Praktijk - Fysiopraktijk Zeist
- **Tech Stack**: Hono + TypeScript + Tailwind CSS + Chart.js + Supabase

## URLs
- **Preview**: https://3000-ivwhd9ktlpmi0odg58u71-0e616f0a.sandbox.novita.ai
- **Portaal (patienten)**: https://3000-ivwhd9ktlpmi0odg58u71-0e616f0a.sandbox.novita.ai/portaal
- **Platform**: Netlify (Netlify Functions)

## Voltooide Features

### Therapeut Omgeving (paarse UI)
- [x] Dashboard met statistieken (actieve patienten, assessments, lab-testen, protocollen)
- [x] Patientenbeheer (aanmaken, bewerken, archiveren + **permanent verwijderen**)
- [x] Quick Triage Assessment (15 vragen, 5-10 minuten)
- [x] Automatisch categoriserings-algoritme (7 categorieen)
- [x] Risicoprofiel generatie met urgentie-indicatie
- [x] Lab-test aanbevelingen per categorie (bloed + ontlasting + overig)
- [x] Lab-resultaten invoer met automatische interpretatie
- [x] Gepersonaliseerd protocol generatie (supplementen, voeding, leefstijl, medicatie)
- [x] Patientprofiel met alle data overzichtelijk
- [x] Print functionaliteit
- [x] **Portaalcode genereren** voor patienten (vanuit patientprofiel)

### Patienten Verwijderen
- [x] **Soft delete** (`DELETE /api/patients/:id`): archiveert patient
- [x] **Hard delete** (`DELETE /api/patients/:id/permanent`): verwijdert patient + alle gekoppelde data definitief
- [x] **Delete-knoppen** in dashboard (prullenbak-icoon) en patientprofiel (rode knop)
- [x] **Bevestigingsdialoog** met waarschuwing dat het niet ongedaan kan worden gemaakt

### Progressie & Symptomen
- [x] **7 individuele symptoomscores**: vermoeidheid, slaap, spijsvertering, stemming, pijn, concentratie, honger (schaal 1-10)
- [x] **Gewicht & BMI trendgrafiek** (Chart.js lijndiagram over tijd)
- [x] **Buikomvang & Energie trendgrafiek** (dual-axis chart)
- [x] **Symptoom Radar Chart** (spider/radar diagram van meest recente meting)
- [x] **Symptoom Lijndiagram** (trends van alle 7 symptomen over tijd, met gekleurde lijnen)
- [x] **Uitgebreide datatable** met alle symptoomscores als gekleurde badges
- [x] **Gewichtstrend-pijlen** (verschil t.o.v. vorige meting, groen/rood)

### Lab-resultaat Visualisatie
- [x] **Visuele range-bars**: gekleurde balkjes die waarden binnen optimale range tonen
- [x] **Trend-pijlen**: vergelijking met vorige lab-ronde (stijgend/dalend icoon)
- [x] **Datum per lab-ronde**: zichtbaar wanneer elk lab-onderzoek is afgenomen

### Follow-up Planning
- [x] **Follow-up CRUD API**: aanmaken, bijwerken, verwijderen van follow-ups
- [x] **Type-selectie**: Check-in, Meting, Lab-controle, Protocol evaluatie, Anders
- [x] **Status-tracking**: Gepland, Voltooid, Geannuleerd, Gemist
- [x] **Achterstallig-indicator**: oranje badge bij verlopen follow-ups
- [x] **Inline status-wijziging**: direct markeren als voltooid of geannuleerd

### Patienten Portaal (NIEUW - groene UI)
- [x] **Landingspagina** (`/portaal`): uitleg over gebruik, voordelen, 7 categorieen, disclaimer
- [x] **Disclaimer**: uitgebreide medische disclaimer, AVG, orthomoleculaire basis
- [x] **Inloggen** (`/portaal/inloggen`): 8-karakter toegangscode
- [x] **Menu** (`/portaal/menu`): keuze uit vragenlijst, lab-upload, disclaimer, uitloggen
- [x] **Vragenlijst** (`/portaal/vragenlijst`): zelfde 15 triage-vragen, auto-analyse, resultaatpagina
- [x] **Lab-upload** (`/portaal/lab-upload`): drag-drop upload van foto's/PDF's van labresultaten
- [x] **Resultaatpagina**: samenvatting van categorisatie + risiconiveau + vervolgstappen
- [x] **Toegangscode systeem**: therapeut genereert unieke code per patient vanuit patientprofiel

## Werkwijze Patienten Portaal

### Voor de therapeut (Marc):
1. Open patientprofiel → klik **"Portaal Code"** knop
2. Een unieke 8-karakter code wordt gegenereerd (bijv. `AB3CDE7F`)
3. Geef deze code aan de patient (per mail, print, of mondeling)

### Voor de patient:
1. Ga naar `/portaal` → lees uitleg en disclaimer
2. Klik **"Inloggen"** → voer 8-karakter code in
3. Kies **"Vragenlijst Invullen"** → beantwoord 15 vragen
4. Bekijk automatisch gegenereerde resultaatpagina
5. Optioneel: **"Lab-formulier Uploaden"** → upload foto/PDF van labresultaten

## 7 Patientcategorieen
1. **Metabole Weerstand** - Afvallen lukt niet ondanks inspanningen
2. **Schildklier-gedreven** - Moe, koud, droge huid (Hashimoto)
3. **PCOS/Hormonen** - Onregelmatige cyclus, buikvet (vrouwen)
4. **Cortisol-gedreven** - Dagelijkse stress, slechte slaap
5. **Insuline-gedreven** - Suikercravings, honger na maaltijd
6. **Medicatie-gerelateerd** - Statines (CoQ10), antidepressiva
7. **Standaard Leefstijl** - Geen rode vlaggen

## Pagina's & Routes

### Therapeut Omgeving
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

### Patienten Portaal
| Route | Beschrijving |
|---|---|
| `/portaal` | Landingspagina met uitleg, voordelen, 7 categorieen, disclaimer |
| `/portaal/inloggen` | Inloggen met 8-karakter toegangscode |
| `/portaal/menu` | Menu: vragenlijst, lab-upload, disclaimer, uitloggen |
| `/portaal/vragenlijst` | Zelf-invul vragenlijst (15 vragen) met resultaatpagina |
| `/portaal/lab-upload` | Lab-formulieren uploaden (foto/PDF) |

## API Endpoints

### Therapeut API
| Method | Route | Beschrijving |
|---|---|---|
| GET | `/api/stats` | Dashboard statistieken |
| GET | `/api/patients` | Alle actieve patienten |
| GET | `/api/patients/:id` | Patient met alle gerelateerde data |
| POST | `/api/patients` | Nieuwe patient aanmaken |
| PATCH | `/api/patients/:id` | Patient updaten |
| DELETE | `/api/patients/:id` | Patient archiveren (soft delete) |
| DELETE | `/api/patients/:id/permanent` | Patient + alle data definitief verwijderen |
| GET | `/api/patients/:id/portal-code` | Bestaande portaalcode ophalen |
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

### Portaal API
| Method | Route | Beschrijving |
|---|---|---|
| POST | `/api/portal/generate-code` | Portaalcode genereren (therapeut) |
| POST | `/api/portal/verify-code` | Toegangscode verifieren (patient) |
| POST | `/api/portal/assessment` | Vragenlijst indienen via portaal |
| POST | `/api/portal/lab-upload` | Lab-document upload via portaal |

## Data Architectuur
- **Database**: Supabase (PostgreSQL)
- **Tabellen**: patients, assessments, lab_tests, supplement_protocols, progress_tracking, follow_ups
- **RLS**: Geactiveerd met anon + authenticated policies
- **JSONB velden**: responses, categories, risk_scores, supplements, nutrition, lifestyle, symptoms
- **Portaalcodes**: opgeslagen in `patients.portal_code` kolom (of `patients.notes` als fallback)

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

## Database Migraties (BELANGRIJK)

### Uit te voeren in Supabase SQL Editor:
1. `supabase-setup.sql` - Basis tabellen
2. `supabase-migration-002.sql` - Risicoprofiel + ontlasting kolommen
3. `supabase-migration-followups.sql` - Follow-ups tabel
4. `supabase-migration-003-portal.sql` - Portal code kolommen (optioneel, werkt ook zonder)

### Nog aan te maken tabellen:
- `follow_ups` - Follow-up planning (**voer `supabase-migration-followups.sql` uit**)
- `patients.portal_code` kolom (**voer `supabase-migration-003-portal.sql` uit**, optioneel)

## Setup Instructies

### 1. Supabase Database
1. Voer `supabase-setup.sql` uit voor basis tabellen
2. Voer `supabase-migration-002.sql` uit voor extra kolommen
3. Voer `supabase-migration-followups.sql` uit voor follow-ups tabel
4. Voer `supabase-migration-003-portal.sql` uit voor portal code kolom (optioneel)

### 2. Environment Variables

**Lokale ontwikkeling** - in `ecosystem.config.cjs` (env sectie) of `.dev.vars`:
```
SUPABASE_URL=https://jouw-project.supabase.co
SUPABASE_ANON_KEY=jouw-anon-key
```

**Netlify productie** - stel in via Netlify Dashboard > Site Settings > Environment Variables:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### 3. Development
```bash
npm install
npm run dev          # Vite dev server (port 5173)
# of via PM2:
pm2 start ecosystem.config.cjs  # Vite dev server (port 3000)
```

### 4. Build & Deploy
```bash
npm run build        # Bouwt dist/ directory met Netlify Function
npm run deploy       # Build + deploy naar Netlify productie
npm run deploy:draft # Build + deploy als draft (preview URL)
```

## Deployment
- **Platform**: Netlify (voorheen Cloudflare Pages)
- **Build Tool**: Vite + @hono/vite-build/netlify-functions
- **Runtime**: Netlify Functions (Node.js 20)
- **Status**: Development
- **Last Updated**: 2026-03-10

### Hoe deployen naar Netlify:
1. Maak een account aan op [netlify.com](https://netlify.com)
2. Koppel je GitHub repository OF deploy handmatig:
   ```bash
   npm install -g netlify-cli
   netlify login
   netlify init          # Koppel aan nieuw of bestaand project
   npm run deploy        # Deploy naar productie
   ```
3. Stel environment variables in via Netlify Dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`

### Projectstructuur (Netlify)
```
webapp/
├── src/index.tsx          # Hono app (alle routes + API)
├── public/static/         # Static assets (wordt gekopieerd naar dist/)
├── dist/                  # Build output
│   ├── index.js           # Netlify Function (Hono app)
│   └── static/            # Static files
├── netlify.toml           # Netlify configuratie
├── vite.config.ts         # Vite build met netlify-functions plugin
├── ecosystem.config.cjs   # PM2 configuratie voor lokale dev
└── package.json           # Scripts: dev, build, deploy
```

## Aanbevolen Volgende Stappen
1. Voer alle migratie-SQL bestanden uit in Supabase SQL Editor
2. Deploy naar Netlify productie (`npm run deploy`)
3. Overweeg lengte/BMI veld toevoegen aan patients tabel
4. PDF export mogelijkheid voor protocollen
5. E-mail notificaties voor follow-ups
6. Authenticatie voor therapeut-omgeving (nu onbeveiligd)
