# src/api/routes/ — HTTP endpointi

## Namen

Fastify route handlerji. Register-ajo se v `src/api/index.ts` pod `/api` prefixom. Trenutno štiri datoteke:

| Fajl | Vsebina |
|---|---|
| `users.ts` | Auth (register, login, refresh), profile settings, GDPR user delete, CSV export |
| `image-processing.ts` | Upload, list, per-upload details, per-receipt view |
| `receipt-editing.ts` | PATCH za receipts & line items, soft delete/restore, single-receipt retry |
| `files.ts` | Static file serving (`/api/files/:filename`) |

## Invariante (kritično)

1. **PATCH endpointi so EDINA pot za zapis v `receipt_edit_history`.** Vsak field-level change userja MORA producirati edit history entry (`entityType`, `entityId`, `fieldName`, `oldValue`, `newValue`, `changedBy`). Ne bypass preko direct DB update. Ta tabela je training corpus (glej root + `db/CLAUDE.md`).
2. **Soft delete (`deletedAt`)** se setira le preko dediciranih route-ov. Queries morajo filtrirati `isNull(deletedAt)` razen admin/audit pregledov.
3. **Ownership check VEDNO**: `upload.userId === request.user.id`. Odpravi 403 pred akcijo, ne izvaji na zaupanje ID-ja iz URL-ja. Trenutno vzorec v `resolveReceiptForEdit`.
4. **Auth middleware** (`auth.ts`) sprejema OBOJE — JWT `Bearer` IN `X-Internal-Api-Key` (env `INTERNAL_API_KEY`). Handler lahko ugotovi preko `request.user` vs. `request.isInternal`. Interne routes (npr. worker callbacks) naj ne sprejemajo JWT in obratno — ne mešaj v istem handlerju brez zavesti.
5. **Upload status `duplicate`** se določi ob upload-u (image hash match); worker to skipa. Če spreminjaš dedup logiko, koordiniraj oboje.
6. **Response shape je "javni API"** za frontend aplikacijo. Nepotrebne spremembe oblike (rename, prestavitev) zlomijo klienta. Dodajanje field-ov je varno; brisanje/rename zahteva coordination.

## Tabela endpointov (high-level)

| Metoda | Pot | Auth | Opis | Piše edit history |
|---|---|---|---|---|
| POST | `/api/register` | public | Registriraj userja | — |
| POST | `/api/login` | public | JWT + refresh | — |
| POST | `/api/refresh` | cookie | Rotate access token | — |
| GET | `/api/me` | JWT | Profil + settings | — |
| PATCH | `/api/me` | JWT | Update settings | — |
| DELETE | `/api/me` | JWT | GDPR hard delete userja | — |
| GET | `/api/users/:id/export` | JWT | CSV export | — |
| POST | `/api/receipts/upload` | JWT | Multipart upload → enqueue | — |
| GET | `/api/receipts` | JWT | List uploadov za userja | — |
| GET | `/api/receipts/:uploadId` | JWT | Details enega uploada | — |
| GET | `/api/receipts/:uploadId/receipts/:id/image` | JWT | Get receipt image URL | — |
| PATCH | `/api/receipts/:uploadId/receipts/:id` | JWT | Edit receipt field | **da** |
| PATCH | `/api/receipts/:uploadId/receipts/:id/items/:itemId` | JWT | Edit line item | **da** |
| DELETE | `/api/receipts/:uploadId/receipts/:id` | JWT | Soft delete | **da** |
| POST | `/api/receipts/:uploadId/receipts/:id/restore` | JWT | Undo soft delete | **da** |
| POST | `/api/receipts/:uploadId/receipts/:id/retry` | JWT | Re-queue single-receipt processing | — |
| GET | `/api/files/:filename` | public(!) | Static file serve | — |

> **Opozorilo:** `/api/files/:filename` je trenutno brez auth-a. Pri razumnih imenih (hash-based) je to minimal risk, ampak če image path ever pride v enumerable shape, dodaj ownership check.

## Konvencije

### Validacija
- **Zod schemas v `src/validation/`** za request body-je in query parametre. Uporabi `schema: { body: zodToJsonSchema(...) }` ali runtime parse na začetku handlerja.
- **Multipart**: `@fastify/multipart` je konfiguriran na `fileSize: 10 MB`. Dodajajoč tudi `files: 1` kjer je smiselno.
- Query params: parse z `Number(...)` oz. zod — ne zaupaj stringu.

### Error handling
- **Vrne `{ error: string, ...details? }` JSON** z ustreznim status kodom. Ne propagiraj throwable-e v Fastify default handler (leak-a stack trace).
- **Zaželen central error handler** (Fastify `setErrorHandler`) — TODO faza 4, da se ne ponavlja try/catch v vsakem routeu.

### DB access
- Direct preko `db` importa iz `src/db/index.js`. Uporabi `db.transaction(async tx => …)` za multi-statement atomično sekvenco (zlasti pri edit history insert + update).
- Zmeraj `.where(eq(tableName.id, id))` — pazi da ne manjka where clause (full-table update bug).
- Listanje: uporabi `orderBy` + `limit` + `offset`; za velike tabele dodaj ustrezne indekse v db layer-ju.

### Authorization pattern
```ts
async function resolveOwnership(uploadId, userId): Promise<{upload}|{error,statusCode}> { … }

fastify.patch('/…', { preHandler: authenticate }, async (req, reply) => {
  const userId = req.user!.id;
  const result = await resolveOwnership(uploadId, userId);
  if ('error' in result) return reply.status(result.statusCode).send({ error: result.error });
  // … proceed
});
```

## Pasti

- **Dinamični update builderji v `receipt-editing.ts`** uporabljajo `Partial<InferInsertModel<...>>` (`ReceiptUpdate`, `LineItemUpdate`) — type-safe; Drizzle zavrne napačna imena polj. Pri dodajanju novega polja: posodobi (1) allowed-fields list v handlerju, (2) edit-history `fieldName` entry (konsistentno s camelCase keyem).
- **`files.ts` direct path serving**: `UPLOADS_DIR` resolver. Ne sprejemaj `..` v `:filename` (path traversal). Preveri da je Fastify static plugin konfiguriran zaščitno.
- **CSV export tipi** v `users.ts`: uporabi `CsvReceipt` / `CsvLineItem` (exportani iz `services/csvGenerator.ts`), ne širi `any`-ja. `keywords` je `unknown` (JSON column) — normaliziraj v `formatKeywords()` helper-ju pred rabo.
- **Rate limit per-user ne obstaja.** En user lahko upload-a v neskončnost (do file size limita); AI quota je globalna. Dodaj `@fastify/rate-limit` v fazi 4.
- **Cookie-based refresh token** (`@fastify/cookie`): httpOnly + secure v produkciji. Preveri environment-specific config.
- **JWT secret** iz `process.env.JWT_SECRET` brez default-a — fail-fast če manjka (pri boot-u, ne pri prvem login-u).

## Testiranje sprememb

- `fastify.inject({ method, url, payload, headers })` za unit-style teste brez real Redis-a — mock queue.
- Curl primeri v `testing_endpoints.md` (root level dokumentacija).
- PATCH: preveri z GET-om, da:
  a) field je posodobljen,
  b) `editedAt` je posodobljen,
  c) `reviewStatus` ni rollback-an,
  d) nov zapis v `receipt_edit_history` z old/new value + correct `changedBy`.

## Povezane datoteke

- `../auth.ts` — authenticate hook, JWT + internal API key
- `../index.ts` — Fastify server bootstrap, route registration
- `../../services/authService.ts` — JWT sign/verify, password hash
- `../../validation/authSchemas.ts` — zod za login/register
- `../../queue/index.ts` — receipt processing queue (upload enqueue-a tukaj)
- `../../db/index.ts` — `db` instance
