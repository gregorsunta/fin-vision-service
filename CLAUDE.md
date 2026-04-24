# fin-vision-service — Development Guidelines

> **Backend servis za digitalizacijo računov.** Node 22 + TypeScript, Fastify API + BullMQ worker, MySQL (Drizzle), Redis, Google Cloud Vision + Gemini/Groq za OCR/AI, Python sidecar (`cv-detector-service`) za receipt detection. Glej `README.md` za setup.

## Orientacija (kje je kaj)

```
src/
├── api/            HTTP layer (Fastify)
│   ├── index.ts    server bootstrap
│   ├── auth.ts     JWT + internal-key middleware
│   └── routes/     <-- endpoints ... glej routes/CLAUDE.md
├── workers/        <-- BullMQ pipeline ... glej workers/CLAUDE.md
├── services/       <-- domain logika (OCR, AI extraction, split, dedup) ... glej services/CLAUDE.md
├── ai/             <-- multi-provider abstrakcija (Gemini, Groq) ... glej ai/CLAUDE.md
├── db/             <-- Drizzle schema + client ... glej db/CLAUDE.md
├── queue/          BullMQ queue definicija + ReceiptJobData
├── validation/     zod shemi (auth, kmalu tudi upload)
└── utils/          file-utils (hash, WebP compress, save)

drizzle/            generirane migracije (glej drizzle/CLAUDE.md)
cv-detector-service/ Python FastAPI sidecar (glej njegov CLAUDE.md)
uploads/            user images (ne brisati brez explicit approval)
```

## Key workflow: upload → persist

1. **POST /api/receipts/upload** (API) — multipart + JWT auth → compress to WebP → hash → dedup-hash check → insert `receipt_uploads` (status=processing) → enqueue BullMQ job.
2. **Worker** (`workers/receiptProcessor.ts`) — fetch upload, split (cv-detector → Gemini fallback), persist `splitMetadata`, for vsak box: OSD orientation → save → TX insert `receipts` row → `analyzeReceipts` (OCR+AI+validation) → save line_items + validation warnings → dedup check → (on rate-limit) mark `rate_limited`, stop batch → finalize upload status.
3. **User edit** (`PATCH /api/receipts/:uploadId/receipts/:id`) — update field + audit log v `receipt_edit_history`.
4. **Resume** — scheduler (60s interval) pogleda `rate_limited` receipte za userje z `autoResumeRateLimited=true`; če `resetTime` preteče, re-queue single-receipt job.

## ML Training Data Awareness

Ta servis aktivno gradi labeled dataset za bodoče fine-tuning receipt OCR modela (`ML_TRAINING_PLAN.md`). Vsaka interakcija z receipti in editi mora **ohranjati training data integriteto**.

### Kaj je training data

| Source | Kaj predstavlja |
|---|---|
| `receipt_edit_history` | Vsaka user korekcija = labeled primer (napačen AI output → pravi) |
| `reviewStatus = 'reviewed'` | User potrdil, da je receipt pravilen = high-quality positive primer |
| `editedAt IS NOT NULL` | Receipt bil popravljen = training primer z ground truth |
| `editedAt IS NULL` + `reviewStatus = 'not_required'` | AI ok, ni potreben popravek = positive primer |
| `receiptFormat` v `processingMetadata` | Format label (za stratified training sets) |
| Receipt slike (processed/reviewed) | Input slike za fine-tuning — NE brisati brez preverbe |

### Pravila (NIKOLI ne zlomi)

- **`receipt_edit_history` NIKOLI ne truncate/delete.** Cleanup skripte na tej tabeli zahtevajo eksplicitno user approval.
- **`reviewStatus` transitions so ireverzibilne labele.** Ko `reviewed`, ne resetiraj programatično.
- **`receiptFormat` mora ostati accurate.** Sprememba enum vrednosti zahteva backfill obstoječih zapisov.
- **Receipt slike za `status='processed'` NE brisati** dokler training export skripta ne potrdi vključitve. Flagaj vsak storage-cleanup script, ki se jih dotakne.
- **Nova polja v `receipts` ali `line_items`** → razmisli, ali je field useful training label. Komentiraj v migraciji.

### Training pipeline

`needs_review → user edits → approve` je primarni mehanizem za labeled correctionse. **Ne shortcut-aj** ali avto-approvaj receipte brez user interakcije.

Export script (še ni napisan): `scripts/export-training-data.ts` — trigger pri ~500 reviewed/edited receiptih, output JSONL `{imagePath, groundTruth}` za Donut fine-tuning.

### Prompt engineering vs. fine-tuning

Do fine-tuning-a accuracy izboljšave živijo v `src/services/receipt-analysis.ts` (glej `services/CLAUDE.md` za kritične principe: "read, don't calculate", receiptFormat commitment, discount column vs row, date-swap heuristika).

## Build & run

```bash
# Setup
docker compose up -d mysql redis cv-detector
npm install
npm run db:migrate

# Dev
npm run dev                  # API + worker parallel
npm run dev:api              # samo API
npm run dev:worker           # samo worker

# Production build
npm run build                # tsc
npm run start:api
npm run start:worker

# DB
npm run db:generate          # new migration iz schema.ts
npm run db:studio            # Drizzle Studio browser

# Testi (kmalu — faza 3)
npm test
```

## Key env varji (hitri pogled)

Celoten seznam pride v `src/config/index.ts` (faza 1). Trenutno razkropljeno.

| Var | Obvezno | Namen |
|---|---|---|
| `DATABASE_URL` | da | MySQL connection string |
| `REDIS_HOST`, `REDIS_PORT` | da | BullMQ backing |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | da | Auth |
| `INTERNAL_API_KEY` | da | Service-to-service auth |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | vsaj eden | AI providerji |
| `GOOGLE_APPLICATION_CREDENTIALS` | da | GCP Vision (pot do `gcp-credentials.json`) |
| `CV_DETECTOR_URL` | ne | Default `http://localhost:8001` |
| `AI_RECEIPT_DELAY_MS` | ne | RPM pacing; default 12000 |
| `OCR_PREPROCESS` | ne | `true` = sharp preprocessing PRED Vision |
| `NODE_ENV` | ne | `development` → pino-pretty logs |

## Arhitekturne zabeležke

- **API writer ne analizira sinhrono.** Upload enqueua; worker obdela. Ne dodajaj blocking AI klica v API route.
- **`receipt_edit_history` writes IZKLJUČNO preko PATCH endpointov.** Nikoli direct DB update za field change.
- **`processingMetadata` (JSONB)** hrani per-receipt AI metadata vključno `receiptFormat` — vedno polni.
- **`reviewStatus`**: `'not_required'` | `'needs_review'` | `'reviewed'`.
- **Sidebar stats**: `successful` = vsi `status='processed'`; `needsReview` je ločen — `successful - needsReview = čisti receipts`.

## Nested konteksti (LLM: preveri preden urejaš)

- `src/ai/CLAUDE.md` — provider abstrakcija, fallback chain, rate limiter
- `src/services/CLAUDE.md` — OCR/AI pipeline invariante, tuning surface
- `src/workers/CLAUDE.md` — job lifecycle, failure modes
- `src/api/routes/CLAUDE.md` — HTTP contract, edit history rule
- `src/db/CLAUDE.md` — schema & migration rules, JSON parsing
- `drizzle/CLAUDE.md` — migration workflow
- `cv-detector-service/CLAUDE.md` — Python sidecar (drugačen ekosistem!)

## Povezane docs (non-CLAUDE)

- `README.md` — setup, Docker Compose, endpoint pregled
- `ML_TRAINING_PLAN.md` — 4-fazni ML training plan
- `florence2_detection_plan.md` — predlog alternative za Gemini detection
- `user_guidance.md`, `settings_explanation.md`, `testing_endpoints.md` — tuning & QA (predvsem splitter)
