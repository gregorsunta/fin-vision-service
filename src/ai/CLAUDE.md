# src/ai/ — Multi-provider AI abstrakcija

## Namen

Enotna plast za generativni AI (text + vision) z **ordered fallback chain**. Trenutno dva backend-a: Google Gemini (`gemini-provider.ts`) in Groq (`groq-provider.ts`). Uporaba: `getAIService().generate({ prompt, images?, responseFormat?, responseSchema? })`.

## Arhitektura na enem zaslonu

```
AIService (ai-service.ts)
  │
  ├─ providers[]            ordered po prioriteti
  │   ├─ RegisteredProvider { provider: AIProvider, factory: ProviderFactory }
  │   │   ↳ factory.detectRateLimit(error) → { is429, isTransient, retryAfterMs }
  │   └─ …
  ├─ rateLimiter            shared singleton (getRateLimiter())
  └─ fallbackEnabled        config flag

Flow po generate():
  eligibleProviders = filter by capability (vision, spatialReasoning, textGeneration)
  for provider in eligibleProviders:
    if internal rate-limit signals unavailable AND fallback enabled AND not last → skip
    try provider.generate():
      ok → recordRequest(); return
      429 → markExhausted(retryAfterMs); fallback to next OR throw RateLimitExceeded
      503/transient → backoff, retry up to 2×
      other → fallback to next OR throw AIGenerationError
```

## Provider interface (`types.ts`)

```ts
interface AIProvider {
  readonly name: AIProviderName;          // "gemini:gemini-2.5-flash"
  readonly capabilities: AICapabilities;  // { vision, textGeneration, spatialReasoning }
  generate(options: AIGenerateOptions): Promise<AIGenerateResult>;
}
```

`ProviderFactory` (v `providers/<kind>-provider.ts`) mora poleg `create(config)` implementirati `detectRateLimit(error)` — **to je kritično**. Brez pravilne klasifikacije napak fallback chain ne deluje.

## Invariante (LLM: česar NE sme zlomiti)

1. **Rate limiter je single shared instance (`getRateLimiter()`)**. State je procesno-lokalen; če scale-aš worker horizontally, stanje NI sinhronizirano. To je namensko — `markExhausted()` tako ali tako počaka na real 429, ki pride vsakemu procesu ločeno.
2. **Provider name je unique identifier** oblike `"<kind>:<model>"` (npr. `"gemini:gemini-2.5-flash-lite"`). Dva provider instance-a z istim imenom = counter conflict. Pri dodajanju novega providerja vedno uporabi ta format.
3. **`capabilities.spatialReasoning`** — "Lite"/"Nano" modeli SO PREDNJE nastavljeni na `false`. Ne spreminjaj tega zaradi receipt splitterja, ki opt-ins `requireSpatialReasoning: true`. Če model izkaže dober box detection, posodobi capability eksplicitno.
4. **JSON mode pri Gemini**: odgovor včasih pride nazaj kot plain string (brez JSON parsing). Caller MORA validirati z zod/schema pred uporabo. Ne uvajaj assumption, da je response že parsean.
5. **Groq multimodal** zahteva `content` array (text + image parts), ne preprosto string. Pravi tip: `Array<Groq.Chat.ChatCompletionContentPart>`, sestavljen message pa `Groq.Chat.ChatCompletionUserMessageParam` (glej `groq-provider.ts`). Ne vračaj na `as any`.
6. **`recordRequest()` kliči samo ob uspehu.** Če kličeš ob vsakem poskusu, rate-limit okno se zapolni s failed calli.

## Tuning surface

Env-driven (preko `config.ts`; z refactorjem se bo centraliziralo v `src/config/index.ts`):

| Var | Namen |
|---|---|
| `AI_PROVIDERS` | CSV fallback order (`gemini:flash,gemini:flash-lite,groq:llama`) |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | API credentials |
| `GEMINI_MODEL_PRIMARY` / `GEMINI_MODEL_FALLBACK` | Gemini modelska imena |
| `GROQ_MODEL` | Groq modelsko ime (npr. `llama-3.3-70b-versatile`) |
| `AI_RATE_LIMIT_<PROVIDER>` | Requests per 24h (default 1000) |
| `AI_FALLBACK_ENABLED` | `true` = chain; `false` = samo prvi (za testiranje) |

## Dodaj nov provider (koraki)

1. Ustvari `providers/<kind>-provider.ts` z classom, ki implementira `AIProvider`.
2. Izpostavi `ProviderFactory` (v istem file-u ali `providers/registry.ts`):
   ```ts
   export const myFactory: ProviderFactory = {
     create(config) { return new MyProvider(config); },
     detectRateLimit(err) { /* parse 429, Retry-After, 503 */ },
   };
   ```
3. Registriraj v `providers/index.ts` preko `getProviderFactory(kind)`.
4. Dodaj `AIProviderKind` enum value v `types.ts`.
5. Dodaj env parsing v `config.ts` (ali novi `src/config/index.ts`).
6. Unit test: `ai/ai-service.test.ts` mora potrditi, da novi kind pride v fallback chain brez regresije.

## Pasti (caveati)

- **`detectRateLimit` false negatives**: Gemini včasih vrne 429 kot 500 z message-om (SDK bug-i). Če provider ne klasificira pravilno, AIService reportira `AIGenerationError` namesto ratelimit-a in fallback se ne zgodi. Logiraj raw error pri implementaciji novega providerja.
- **`retryAfterMs` nedorečen**: če provider ne vrne Retry-After header-ja, `markExhausted` pade na 60s default. Dnevni limit "izgubljen" če provider dejansko pošilja 429 zaradi per-minute throttle. To je sprejeta simplifikacija.
- **Token usage tracking ne obstaja**. Rate limiter šteje samo requeste, ne tokenov. Pri velikih promptih quota izteče hitreje kot pričakovano.
- **Fallback pri successful 4xx (razen 429)**: trenutno IDE pade v `AIGenerationError` veji. Če želiš bolj granularno klasifikacijo (npr. 400 invalid image → ne fallback, takoj throw), dopolni `detectRateLimit` v faktorju (ali dodaj `detectPermanentFailure`).
- **Vision capability** ni shared: Gemini vsi imajo `vision=true`; Groq samo `meta-llama/llama-4-*` modeli. `requireVision: true` callerji **morajo** spoštovati to (splitter, extractor).

## Testiranje sprememb

- Unit (po vzpostavitvi test harness-a): mockaj provider `generate`, simuliraj 429/503/ok kombinacije, verify fallback order in rate-limiter state transitions.
- Integration (manual): nastavi `AI_FALLBACK_ENABLED=false` + `GEMINI_MODEL_PRIMARY=invalid-model` → preveri, da dobiš `AIGenerationError` (ne silent fallback).
- E2e: kill Gemini quota / mock 429 → preveri, da Groq prevzame z istim promptom (ne izgubiš JSON schema enforcement-a).

## Povezane datoteke

- `ai-service.ts` — orchestrator
- `rate-limiter.ts` — single-window counter (ne per-user!)
- `errors.ts` — `AIRateLimitExceededError`, `AIProviderUnavailableError`, `AIGenerationError`
- `config.ts` — env parsing (do migracije v centralni config)
- `providers/gemini-provider.ts`, `providers/groq-provider.ts`
- `providers/registry.ts` / `providers/index.ts` — factory wiring
- Uporaba: `src/services/receipt-analysis.ts` (primary), `src/services/image-splitter.ts` (spatial reasoning)
