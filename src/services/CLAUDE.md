# src/services/ — Domain logika

## Namen

Tu živi poslovna logika fin-vision-a: **OCR + AI receipt extraction, image splitting, duplicate detection, category ontology, auth primitivi, CSV export, resume scheduling**. Routes in workers kličejo te servise; servisi nikoli ne kličejo route-ov ali workerjev nazaj (one-way dependency).

## Pregled modulov

| Fajl | Odgovornost |
|---|---|
| `receipt-analysis.ts` (1491 vrstic) | OCR (Vision + Tesseract) → AI extraction (Gemini/Groq) → validation → retry. **Planiran split v Fazi 2.** |
| `image-splitter.ts` (450) | Detect boxes (cv-detector sidecar → Gemini fallback) → filter/merge → crop. |
| `cv-detector.ts` | HTTP client za Python sidecar (`/health`, `/detect`). |
| `duplicate-detector.ts` | Fuzzy matching (Levenshtein, amount/date/item tolerance) → confidence score. |
| `categories.ts` | Ontology taksonomija + `buildCategoryPromptList()` za AI prompt. |
| `PromptManager.ts` | (Legacy) prompt definicije. Preveri uporabo pred spremembami — možno mrtva koda. |
| `csvGenerator.ts` | Export receipts/items v CSV (user data export). |
| `authService.ts` | bcrypt hash/compare, JWT sign/verify. |
| `resumeProcessing.ts` | Re-queue `rate_limited` receiptov ko reset time preide. |

## Ključne invariante (ne zlomi!)

### Extraction (receipt-analysis)

1. **READ, don't CALCULATE.** AI bere `lineTotal` neposredno iz slike; koda računa `qty × unitPrice` SAMO kot fallback. Razlog: računanje zakrije real training signal (receipt brala ni napačna, AI je narobe prebral stolpec).
2. **`receiptFormat` commitment**: AI declara format PRED ekstrakcijo (simple / multiline-qty / five-column-discount / tabular). Prompt to izrecno zahteva. Ne odstranjuj tega koraka — drastično zniža hallucination.
3. **Discount column vs. discount row**:
   - **Column discount**: znižanje že vključeno v `lineTotal` → NE ustvarjaj ločenega discount item-a.
   - **Row discount**: samostojna vrstica pod produktom → ustvari `itemType: 'discount'`, nastavi `parentLineItemId` na produkt.
4. **Date-swap heuristika** MOLČE popravi DD.MM.YYYY ↔ MM.DD.YYYY (slovenska vs. ameriška notacija). Če dodajaš podporo novi regiji, preveri ali heuristika še drži — npr. DD/MM kjer je "month >12" signal ne obstaja, ni varno.
5. **Sum-of-items vs. total retry**: če `|∑items − total| > tolerance`, trigger-aj retry z corrective prompt-om (AI dobi nazaj OCR text + napako). Do 2 retry-ja max (prepreči infinite loop).
6. **OCR cross-validation**: izvlečene vrednosti (total, date, storeName) validiraš proti OCR text-u. Neujemanje ne prepreči persist-a, se pa zapiše kot `VALIDATION_WARNING` → `reviewStatus = 'needs_review'`.
7. **`notAReceipt` handling**: če AI vrne `notAReceipt=true`, worker nastavi `status='unreadable'` + zapiše NOT_A_RECEIPT error. Ne poskušaj "forcirati" extrakcije proti temu flagu.

### Image splitter

8. **Koordinatni sistem 0–1000**: cv-detector in Gemini oboje vračata normalizirane koordinate (box.x, y, width, height ∈ [0, 1000]). Piksel konverzija SAMO v splitter-ju/cropperju. Ne mešaj piksel boxov v pipeline-u.
9. **Fallback chain**: cv-detector (sidecar) → Gemini LLM → nič (0 boxes → upload `hasReceipts=0`). `splitMetadata.provider` logira kateri je sukcesedural.
10. **Box filtering**: pragovi (aspect ratio, min/max area fraction) so trenutno hardcoded v `image-splitter.ts`. Ko jih spreminjaš, posodobi tudi `user_guidance.md` na root-u (končnim uporabnikom/QA-ju).
11. **`requireSpatialReasoning: true`** pri Gemini fallback-u — lite modeli so slabi pri bbox-ih. Ne odstranjuj tega flag-a.

### Duplicate detection

12. **Multi-factor scoring** (0–100): store name similarity (Levenshtein, 0–30 točk) + amount match (0–30) + date/time tolerance (0–25) + item count (0–15). **Pragovi so tuning surface**; spreminjaj z awareness-om, da višji prag = manj false-pozitivov ampak več zamujenih dvojnikov.
13. **`userAction` semantika**:
   - `pending` = sistem je predlagal match, user ni odločil
   - `confirmed_duplicate` = user potrdil (`isDuplicate=true` + `duplicateOfReceiptId` na receipt)
   - `override` = user izrecno zavrnil (`duplicateOverride=true`; dedup ga več ne predlaga)
14. **Dedup po upload-u IN po receipt analizi**: upload-level hash match (raw image hash, v API handlerju) PRED enqueue; receipt-level fuzzy match PO analizi (preko `checkForDuplicates`). Oba mehanizma sta potrebna (hash ne ulovi re-shoot ali crop).

### Ostalo

15. **`authService.ts`**: `JWT_SECRET` in `JWT_REFRESH_SECRET` iz env-a; fail-fast če manjka. bcrypt rounds = 10 (balansiranje hash cost vs. UX). Če spremeniš, backfill ni potreben (bcrypt hrani rounds v hash-u).
16. **`categories.ts`**: ontology ID-ji so del prompt-a. Sprememba ID-jev → AI začne uporabljati nove → items z old category value-ji obstanejo v DB. Backfill ali keep-old-mapping.
17. **`resumeProcessing.ts`**: `autoResumeEligibleUploads()` pokliče scheduler (`api/index.ts setInterval`) vsakih 60s. Filter: `receipts.status='rate_limited'` IN `user.autoResumeRateLimited=true` IN `metadata.resetTime <= now()`. Ne poganjaj več scheduler-jev v paralel (duplicate re-queue).

## Tuning surface (env)

| Var | Default | Uporablja |
|---|---|---|
| `OCR_PREPROCESS` | `true` | receipt-analysis (grayscale/normalize/sharpen pre-Vision) |
| `AI_RECEIPT_DELAY_MS` | `12000` | worker (RPM delay) — glej `workers/CLAUDE.md` |
| `CV_DETECTOR_URL` | `http://localhost:8001` | cv-detector HTTP client |
| `CV_DETECTOR_TIMEOUT_MS` | hardcoded 60000 (TODO env-ify) | cv-detector |
| `GD_*` | glej `cv-detector-service/CLAUDE.md` | sidecar, ne parent |
| `TESSERACT_LANGS` (TODO) | `slv,eng,deu` | receipt-analysis |
| Splitter thresholds (hardcoded) | — | image-splitter (TODO env-ify in faza 1) |

## Pasti (caveati)

- **`receipt-analysis.ts` je monolitni "god class"** — sestavljanje prompta, poganjanje OCR-ja, AI-ja, validacija, retry. Preden dodajaš feature, razmisli o fazi 2 splitu (`ocr/`, `ai-extraction/`). Hot fixes ok ampak minimalni.
- **`PromptManager.ts`**: preveri če se sploh uporablja (grep za import). Če je mrtva koda, odstrani pri fazi 2. Če uporabljena in razdvojena od dejanskih promptov v `receipt-analysis.ts`, prompti so v dveh mestih = bug potencial.
- **Tesseract worker initialization (~3–5s)** se pojavi podvojeno — enkrat v `receipt-analysis.ts` (language worker), enkrat v `workers/receiptProcessor.ts` (OSD worker). Različni traineddata, enaka inicializacija. Skupni util v `utils/tesseract.ts` planiran (faza 1).
- **Levenshtein in `duplicate-detector.ts`** je naiven O(n×m). Pri dolgih storename-ih (rare) bo počasen; najverjetneje ni bottleneck. Če migriraš na library, preveri lowercase/normalizacija matchinga.
- **`categories.ts`** ima tako kategorije KOT `buildCategoryPromptList()`. Dodaj category → posodobi both.
- **`image-splitter.ts` compresses marked image**: če marked image ne obstaja (fallback path), UI prikaže `originalImageUrl`. Pazi pri null handling-u.
- **Levenshtein je case-normaliziran, diacritic-ni**: `"š"` in `"s"` sta različna znaka. Za SLV storename-e (npr. "Mercator") to redko moti, ampak za edge cases premisli.

## Zaznane sub-domene (po Fazi 2)

Po prenovi bo (planiran razpad):

```
services/
├── ocr/
│   ├── ocr-pipeline.ts
│   └── preprocess.ts
├── ai-extraction/
│   ├── prompt-builder.ts
│   ├── schema.ts
│   ├── extractor.ts
│   └── validator.ts
├── splitter/
│   ├── providers/
│   │   ├── cv-detector.ts
│   │   └── gemini-fallback.ts
│   ├── box-filter.ts
│   └── cropper.ts
├── duplicates/
│   └── duplicate-detector.ts (+ separate scoring helpers)
├── categories.ts
├── csvGenerator.ts
├── authService.ts
└── resumeProcessing.ts
```

Dokler ni done, delaj v obstoječih datotekah ampak razmisli o boundary-ju tvoje spremembe — lažji migracija kasneje.

## Testiranje sprememb

- Unit (po fazi 3): pure functions (Levenshtein, stringSimilarity, score helpers) so lahki za pokritje. Validator in prompt-builder bodo imeli snapshot teste.
- Fixture-based regression: vzorec 5–10 realnih receipt slik + pričakovan JSON → poženi `analyzeReceipts` in primerjaj. Odstopanje > threshold = regresija.
- Manual smoke: upload test slike → preveri `processingMetadata.receiptFormat`, `processingMetadata.analysisModel`, `processingMetadata.retryCount`.

## Povezane datoteke

- `../ai/` — provider abstrakcija (glej `ai/CLAUDE.md`)
- `../db/schema.ts` — persist targets
- `../workers/receiptProcessor.ts` — caller za analyze + split
- `../api/routes/image-processing.ts` — caller za upload dedup check
- `../utils/file-utils.ts` — save/hash utility (uporabljen iz worker-jev)
- `cv-detector-service/` (ločen proces) — glej njegov CLAUDE.md
