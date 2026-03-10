# Weight Loss Assessment Web-App

## Project Overzicht
- **Naam**: Weight Loss Assessment Tool
- **Doel**: Intelligente web-applicatie voor het categoriseren van patiënten met overgewicht/obesitas, identificeren van metabole beperkende factoren, en genereren van gepersonaliseerde interventieprotocollen
- **Voor**: Marc's Orthomoleculaire Praktijk

## URLs
- **Preview**: Wordt gegenereerd na deployment
- **Tech Stack**: Hono + TypeScript + Tailwind CSS + Supabase

## Features (MVP - Fase 1)
- [x] Dashboard met statistieken (actieve patiënten, assessments, lab-testen, protocollen)
- [x] Patiëntenbeheer (aanmaken, bewerken, archiveren)
- [x] Quick Triage Assessment (15 vragen, 5-10 minuten)
- [x] Automatisch categoriserings-algoritme (7 categorieën)
- [x] Lab-test aanbevelingen per categorie
- [x] Lab-resultaten invoer met automatische interpretatie
- [x] Gepersonaliseerd protocol generatie (supplementen, voeding, leefstijl, medicatie)
- [x] Patiëntprofiel met alle data overzichtelijk
- [x] Progressie tracking (gewicht, buikomvang, energie)
- [x] Print functionaliteit

## 7 Patiëntcategorieën
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
| `/` | Dashboard - overzicht statistieken en recente patiënten |
| `/patients` | Patiëntenlijst |
| `/new-patient` | Nieuwe patiënt aanmaken |
| `/triage/:patientId` | Quick Triage vragenlijst (15 vragen) |
| `/results/:patientId/:assessmentId` | Assessment resultaten + categorieën |
| `/patient/:id` | Volledig patiëntprofiel |
| `/lab-entry/:patientId/:labId` | Lab-resultaten invoeren |
| `/protocol/:patientId/:protocolId` | Volledig protocol bekijken |

## API Endpoints
| Method | Route | Beschrijving |
|---|---|---|
| GET | `/api/stats` | Dashboard statistieken |
| GET | `/api/patients` | Alle actieve patiënten |
| GET | `/api/patients/:id` | Patiënt met alle gerelateerde data |
| POST | `/api/patients` | Nieuwe patiënt aanmaken |
| PATCH | `/api/patients/:id` | Patiënt updaten |
| DELETE | `/api/patients/:id` | Patiënt archiveren (soft delete) |
| POST | `/api/assessments` | Nieuwe assessment + auto-classificatie |
| GET | `/api/assessments/:id` | Assessment ophalen |
| GET | `/api/lab-tests/:patientId` | Lab-testen voor patiënt |
| PATCH | `/api/lab-tests/:id/results` | Lab-resultaten invoeren + interpretatie |
| POST | `/api/protocols` | Protocol genereren |
| GET | `/api/protocols/:patientId` | Protocollen voor patiënt |
| POST | `/api/progress` | Progressie meting toevoegen |
| GET | `/api/progress/:patientId` | Progressie voor patiënt |
| POST | `/api/classify-preview` | Classificatie preview (niet opgeslagen) |

## Data Architectuur
- **Database**: Supabase (PostgreSQL)
- **Tabellen**: patients, assessments, lab_tests, supplement_protocols, progress_tracking
- **RLS**: Geactiveerd met anon + authenticated policies
- **JSONB velden**: responses, categories, risk_scores, supplements, nutrition, lifestyle

## Setup Instructies

### 1. Supabase Database Setup
Voer het bestand `supabase-setup.sql` uit in de Supabase SQL Editor:
1. Ga naar Supabase Dashboard → SQL Editor
2. Kopieer en plak de inhoud van `supabase-setup.sql`
3. Klik "Run"

### 2. Environment Variables
Maak een `.dev.vars` bestand aan:
```
SUPABASE_URL=https://jouw-project.supabase.co
SUPABASE_ANON_KEY=jouw-anon-key
```

### 3. Development
```bash
npm run build
npm run dev:sandbox
```

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: Development
- **Last Updated**: 2026-03-10
