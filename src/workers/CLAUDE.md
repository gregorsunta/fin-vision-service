# src/workers/ — BullMQ receipt processing pipeline

## Namen

Ta proces teče ločeno od API strežnika (`npm run dev:worker`). Konzumira `receipt-processing` queue v Redis-u (definirana v `src/queue/index.ts`), izvaja težki pipeline (OCR + AI + DB writes) in zapisuje rezultate. API proces samo **enqueua** job; nikoli ne izvaja analize sinhrono.

## Pipeline — job lifecycle

```
queued
  │
  ├─ single-receipt reprocess? → processSingleReceipt()  (re-queue iz resume / user retry)
  │
  └─ celoten upload:
      1. fetch upload row, preveri ownership
      2. skip če status='duplicate' (se je ugotovilo že pri upload-u)
      3. Branje slike (fs.readFile z nekonsistentnim path resolutionom — TODO fix)
      4. ImageSplitterService.splitImage()  (progress 5-10%)
         ├─ cv-detector sidecar → boxes
         └─ fallback: Gemini (LLM)
      5. Če 0 boxes → status='completed', hasReceipts=0, END
      6. Ustvari marked image (SVG overlay) + save
      7. Persist splitMetadata
      8. for vsak box:
          a. OSD orientation correction (correctOrientationOSD)
          b. Compress to WebP + save
          c. TRANSAKCIJA: dodeli userReceiptNumber (SELECT…FOR UPDATE), insert receipt row
          d. Če prej rate-limited v tej batch → mark 'rate_limited', continue
          e. receiptAnalyzer.analyzeReceipts([buffer]) → OCR + AI + validation
          f. saveExtractedData: update receipt, insert line_items, insert validation warnings
          g. checkForDuplicates → če dvojnik, markReceiptAsDuplicate
          h. Ob AIRateLimitExceededError → mark 'rate_limited', set rateLimitedReached=true (preostali boxes skip)
          i. Druge napake → 'failed' + processing_errors record
          j. Delay (AI_RECEIPT_DELAY_MS, default 12s) pred naslednjim boxom za RPM compliance
      9. Finalize upload status (completed | partly_completed | failed)
```

Napaka pri koraku 1-7 → catch blok: `upload.status='failed'`, insert SYSTEM_ERROR v `processing_errors`. Če je rate-limit → `throw new UnrecoverableError(...)` (BullMQ ne retry).

## Invariante (kritično)

1. **Vsaka napaka MORA imeti zapis v `processing_errors`** — uporabnikova vidnost zanjo gre preko te tabele. Catch bloki brez insert-a = tiha napaka (ghost receipt).
2. **Rate-limit NI job failure.** Pri `AIRateLimitExceededError`:
   - Receipt status → `'rate_limited'`
   - `processing_errors` category=`SYSTEM_ERROR`, metadata.`errorType='RATE_LIMITED'`, `resetTime`
   - Preostali boxes v isti batch → preskoč (skupna quota se ne bo čudežno obnovila)
   - Upload status → `'partly_completed'`
   - Job ne throw-aš (razen v kritičnem outer catch-u, kjer se wrapa v `UnrecoverableError` da prepreči BullMQ retry)
3. **`userReceiptNumber` dodelitev mora biti v transakciji** z `SELECT … FOR UPDATE` (že obstaja). Brez tega race: dve paralelni jobi istega userja dobita isto številko. Unique constraint na `(upload_id, user_receipt_number)` je **TODO** (faza robustnosti).
4. **OSD correction PRED save-om**: oriented buffer se uporabi ZA save file IN za OCR input. Če obrnes vrstni red, se na frontendu prikazuje obrnjena slika, ampak OCR je analiziral pravilno orientirano (ali obratno).
5. **`splitMetadata` se persistira** po splittingu (pred obdelavo posameznih boxov). Tudi če analiza kasneje pade, uporabnik vidi kaj je bilo zaznano (audit).
6. **Single-receipt reprocess pot (`processSingleReceipt`)** ne izvaja splittinga — pride z že cropano sliko. Uporablja se za:
   - Resume rate-limited receipt
   - User-triggered retry posameznega računa
   - Ne spreminjaj njegove logike, ne da bi preveril kličočega (v `routes/receipt-editing.ts` in `resumeProcessing.ts`).

## Failure modes tabela

| `receipts.status` | Kaj pomeni | Akcija |
|---|---|---|
| `pending` | Insertano ampak analiza še ni tekla | Naj counter/UI kaže "Pending" |
| `processed` | AI-jeva ekstrakcija uspela | Lahko needs_review = da če validation warnings |
| `unreadable` | AI je vrnil `notAReceipt=true` | Trajno — uporabnik lahko izbriše |
| `failed` | Exception v extraction ali save | Retry preko resume ali user-action |
| `rate_limited` | Provider quota exhausted pri tem receiptu | Resume ko `resetTime` preide (scheduler ali `autoResumeRateLimited`) |

| `receiptUploads.status` | Kaj pomeni |
|---|---|
| `processing` | Job aktiven ALI waiting |
| `completed` | Vsi receipts `processed` (ali hasReceipts=0) |
| `partly_completed` | Mešano (procesirani + failed/unreadable/rate_limited) |
| `failed` | Vsi `failed` ali `unreadable` |
| `duplicate` | Whole-batch dvojnik (image hash match ob upload-u) |

## Tuning surface (env)

| Var | Default | Pomen |
|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | BullMQ backing |
| `AI_RECEIPT_DELAY_MS` | `12000` | Delay med boxes v eni batch (RPM respect). Nastavi 0 pri paid tier-u. |
| `AI_RECEIPT_DELAY_MS` math | `10 RPM = 6s/call`, 1 receipt = do 3 klicev → 18s varno. 12s za 15 RPM ok. | |
| (kmalu) `BULLMQ_CONCURRENCY` | — | Trenutno ni eksplicitno nastavljeno (default 1) |
| (kmalu) `JOB_TIMEOUT_MS` | — | TODO AbortController integration |

## Pasti

- **Path resolution logika v `fs.readFile`** je ugibanje prefiksov (absolute / `uploads/` / just filename). Fragile. Planirana poenotenje preko `UPLOAD_ROOT` v configu.
- **Podvojeni OSD worker setup**: isti singleton pattern obstaja v `receipt-analysis.ts`. Premik v `src/utils/tesseract.ts` v fazi 1 prenove. Do takrat: urejaj na obeh mestih konsistentno.
- **Global `AIService` singleton**: pri vzporednih jobih vsi delijo rate limit counter. To je namenoma — da en job ne izprazni quote drugega brez signala.
- **`deriveReceiptCategory()`**: preprost majority vote po item categorijah. Diskriminira discount/tax items. Če sprememba affect-a training data (category label), koordiniraj z ML plan-om.
- **`BullMQ UnrecoverableError`** pri rate-limit outer catch: prepreči built-in retry (ki bi zapravljal quoto). Upload ostane `failed` dokler user manualno ne resume-a.
- **Progress reporting**: `job.updateProgress(…)` je best-effort za UI. Ne polni skupni per-receipt progress — samo per-batch.

## Graceful shutdown (trenutno stanje)

`workers/index.ts` handle-a SIGINT/SIGTERM z `receiptProcessorWorker.close()` (BullMQ drain). **Manjka**: terminate Tesseract worker-jev (leak), close DB pool, abort AI calls v flight-u. TODO v fazi 4.

## Testiranje sprememb

- Lokalno: `docker compose up -d mysql redis cv-detector` → `npm run dev` (worker + api).
- Upload fixture slike preko `POST /api/receipts/upload` → opazuj worker logs; preveri:
  - `receipt_uploads.status` transition: `processing` → `completed|partly_completed`
  - `processing_errors` zapisi za warnings
  - `receipt_edit_history` je PRAZNA za novo procesirane (edit history samo za user-correct via PATCH)
- Force rate limit: `GEMINI_API_KEY=invalid` → all receipts morajo pristati v `failed` z `EXTRACTION_FAILURE`, NE `rate_limited` (razlika: quota obstaja, ampak API zavrne).
- Real rate limit: če imaš quota-low Gemini key, pošlji 10+ receipts hkrati → pričakuj mix `processed` + `rate_limited`, upload `partly_completed`.

## Povezane datoteke

- `receiptProcessor.ts` — glavni worker (544 vrstic, planiran split v `stages/`)
- `index.ts` — worker proces entry + graceful shutdown stub
- `../queue/index.ts` — BullMQ queue definicija + `ReceiptJobData` interface
- `../services/resumeProcessing.ts` — re-queue logika za `rate_limited`
- `../services/duplicate-detector.ts` — `checkForDuplicates`, `markReceiptAsDuplicate`
- `../services/image-splitter.ts` — `splitImage()`
- `../services/receipt-analysis.ts` — `analyzeReceipts()`
