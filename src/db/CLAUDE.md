# src/db/ — Drizzle schema & data-layer konvencije

## Namen

`schema.ts` je **edini vir resnice** za DB shemo. Migracije (`/drizzle/*.sql`) se avtomatsko generirajo iz te datoteke preko `drizzle-kit`. `index.ts` izvozi `db` instance; `migrate.ts` je migracijski runner.

## Tabele — high-level

| Tabela | Vloga |
|---|---|
| `users` | Avtentikacija, API ključi, refresh tokeni, per-user settings |
| `receipt_uploads` | **Batch** (ena uploadana slika; vsebuje 1+ receipts). Hrani `splitMetadata`, status batch-a. |
| `receipts` | **Individualni računi** (po splittingu). Ima processing/review status, duplicate info, `processingMetadata`, `userReceiptNumber`. |
| `line_items` | Items na receptu (product / discount / tax / tip / fee / refund / adjustment). Self-referential preko `parentLineItemId` za discount→product linking. |
| `processing_errors` | Validation warnings & hard failures (`IMAGE_QUALITY`, `EXTRACTION_FAILURE`, `SYSTEM_ERROR`, `VALIDATION_WARNING`). |
| `duplicate_matches` | Confidence-scored zaznani dvojniki (pending → confirmed_duplicate / override). |
| `receipt_edit_history` | **PRIMARNI TRAINING KORPUS.** Vsaka uporabniška korekcija = en labeled sample. |

## Invariante (kritično za LLM)

1. **`receipt_edit_history` je ML training corpus.** Glej root `CLAUDE.md`. Nikoli ne generiraj `DROP`, `TRUNCATE`, `DELETE` na tej tabeli. Schema refactor (rename stolpca) → uporabi `ADD + backfill + DROP` v ločenih migracijah.
2. **Soft delete semantika**: `deletedAt IS NOT NULL` = skrito, NE hard delete. Queries morajo filtrirati `deletedAt IS NULL`, razen endpointov ki namensko listajo deleted entries (npr. audit).
3. **Soft delete ni reverzibilen na aplikacijskem nivoju.** `deletedAt` se ne resetira na NULL. Če želiš "undelete", napiši dediciran endpoint + migracijo z eksplicitno user confirmacijo.
4. **`reviewStatus` transitions so ireverzibilne labele**: ko `reviewed`, ostane `reviewed`. Ne programatično resetiraj na `not_required`.
5. **`receiptFormat` (v `processingMetadata` JSON)** je training label. Sprememba enum vrednosti zahteva migracijsko backfill-anje obstoječih zapisov.
6. **`userReceiptNumber` / `receiptUploads.uploadNumber`**: monotonično naraščajoča številka per user. Dodelitev MORA biti v transakciji (uq constraint na `(user_id, upload_number)` obstaja; worker trenutno ročno inkrementira → race-prone, fix v fazi robustnosti).
7. **Slike za `status='processed'` receipts** (v `uploads/` direktoriju) se NE brišejo dokler training export skripta ne potrdi vključitve. Nobenega storage-cleanup scripta brez user approvala.

## Konvencije

### JSON polja
Tipizirano z `$type<T>()` v shemi, VENDAR runtime ni validiran — baza vrne `unknown` obliko. **Vedno parse z zod** (ali runtime guard) pri branju:

```ts
const metadata = processingMetadataSchema.parse(row.processingMetadata ?? {});
```

Polja v shemi:
- `receiptUploads.splitMetadata` → boxes + provider/model
- `receipts.processingMetadata` → ocrProvider, analysisModel, retryCount …
- `receipts.confidenceScores` → per-field confidence
- `receipts.keywords`, `lineItems.keywords` → string[]
- `lineItems.discountMetadata` → type/value/code/originalPrice
- `processingErrors.metadata` → errorType, resetTime, provider (za RATE_LIMITED)
- `duplicateMatches.matchFactors` → breakdown

### Časovni stolpci
- `timestamp('x').defaultNow()` ali ročno nastavljeno v aplikaciji.
- Vse UTC. NE uporabljaj `CURRENT_TIMESTAMP` z MySQL default, ker lahko zdrsne s timezone-om stroja.
- Format imen: `<camelCase>At` → DB `<snake_case>_at`.

### Decimals (denar)
- `decimal('x', { precision: 13, scale: 4 })` za zneske — dovolj za raznovrstne valute.
- Drizzle vrne kot string; konverzija v Number v aplikaciji (pazi na floating-point — pri seštevanju uporabi Big.js/decimal.js ali sešteje v število centov).

### Relations
`*Relations` so definirani ločeno spodaj v shemi in omogočajo `db.query.receipts.findMany({ with: { lineItems: true } })`. Dodajaj relations sočasno z novimi FK-ji, sicer relational queries ne delajo.

### FK-ji
- Trenutno so večinoma `int(...)` brez `references()` — aplikacijsko-stran constraint. **TODO (faza robustnosti):** dodaj explicit `references()` z `onDelete: 'cascade'` kjer smiselno (receipts→uploads, line_items→receipts, upload→users). `receipt_edit_history` NI cascade (ohrani ob delete userja; anonimiziraj `changedBy`).

## Migracije (workflow)

```
1. Edit src/db/schema.ts
2. npm run db:generate         # drizzle-kit → /drizzle/NNNN_<name>.sql
3. Preberi generirani SQL — preveri, da ni destructive kjer ne želiš
4. npm run db:migrate          # zažene migracijo (local MySQL @ localhost:3307)
5. Drizzle Studio (`npm run db:studio`) za sanity pregled
6. Commit: schema.ts + nova SQL + /drizzle/meta/*
```

Glej `drizzle/CLAUDE.md` za migracijske gotchas (imena datotek, editing, destructive ops).

## Pasti

- **Drizzle `$type<T>()` ni runtime guard**: TypeScript misli, da je polje `T`, ampak DB lahko vrne karkoli (legacy data, manual inserts). Parse/validate PRED uporabo.
- **`serial('id').primaryKey()`**: MySQL `BIGINT UNSIGNED AUTO_INCREMENT`. Če tabela pričakuje >2B zapisov, razmisli, vendar za naš domain neomejeno.
- **Retention za `duplicate_matches.user_action = 'pending'`**: trenutno ni cleanup — raste neomejeno. TODO: periodic cleanup (~N dni).
- **Indeksi**: trenutno samo `uq_user_upload_number` in `idx_entity` (na edit history). Počasne queries so verjetne za `receipts(status)`, `receipts(review_status)`, `receipts(user_id, transaction_date)` — dodati v robustness fazi.
- **`receipts` brez `user_id` stolpca!** User ownership gre preko `upload_id → receipt_uploads.user_id`. Queries za "receipts of user X" zahtevajo JOIN. Če kadarkoli denormaliziraš `userId` na `receipts`, poskrbi za konsistenco (trigger/aplikacijski backfill).
- **`users.password`** je trenutno `text` (opomba v kodi pravi: treba je hashirati). `authService.ts` uporablja bcrypt — torej se v praksi hashira, ampak stolpec bi moral biti `varchar(60)` z ustrezno validacijo. Minor tech debt.

## Testiranje sprememb

- Lokalno: `docker compose up -d mysql redis && npm run db:migrate`.
- V Drizzle Studio preveri shema + FK + indeksi.
- Unit test z in-memory SQLite ni preprost (MySQL-specific features kot `mysqlEnum`); za integracijske teste raje `testcontainers` z MySQL image.
- Smoke test: zaženi API + worker, upload test fixture, preveri da se vsi stolpci polnijo.

## Povezane datoteke

- `schema.ts` — shema
- `index.ts` — db instance + connection pool
- `migrate.ts` — migracijski runner
- `/drizzle/*.sql` — generirane migracije (ne edit-aj)
- `drizzle.config.ts` (root) — output path, connection URL
- `src/validation/` — zod shemi (za JSON metadata parsing)
