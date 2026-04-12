# Načrt: Florence-2 za detekcijo bounding boxov računov

## Cilj

Zamenjati trenutno Gemini-only detekcijo bounding boxov v `image-splitter.ts` z **Florence-2** modelom, ki teče lokalno preko `@huggingface/transformers` (ONNX Runtime v Node.js). Gemini ostane kot fallback in se uporablja za analizo vsebine računov.

## Motivacija

### Trenutni problem
- `gemini-2.5-flash` ima na free tier samo 250 RPD → hitro izčrpana kvota med testiranjem
- `gemini-2.5-flash-lite` ima 1000 RPD ampak je nezanesljiv za spatial reasoning (slabe koordinate)
- LLM-based detekcija je v osnovi nezanesljiva za bounding boxe — model halucinira plausible JSON koordinate ki niso grounded v sliki
- Vsaka napaka zahteva re-test, ki porabi novo kvoto

### Zakaj Florence-2
- Microsoftov vision foundation model (2024), MIT licenca
- **Eksplicitno treniran na object detection** — output bounding boxov je del trenirane naloge, ne text generation
- Treniran na 5.4 milijardah anotacij, vključno z grounding nalogami
- Podpira **open vocabulary detection**: pošlješ sliko + tekst "receipt" in dobiš piksel koordinate
- Na standardnih detection benchmark-ih primerljiv z YOLOji
- Open source na HuggingFace, na voljo kot ONNX export

## Tehnična rešitev

### Stack
- **Library**: `@huggingface/transformers` (npm)
- **Runtime**: ONNX Runtime (vključen v library, ne potrebuje PyTorch)
- **Model**: `onnx-community/Florence-2-base-ft` z `int8` kvantizacijo
- **Jezik**: Pure Node.js, brez Python sidecara
- **Integracija**: Direktno v BullMQ workerju

### Resource profile

| Verzija | Disk | RAM v procesu | Inference (1 vCPU shared) |
|---|---|---|---|
| Florence-2-base fp32 | ~1 GB | ~1.5 GB | 15-25s |
| Florence-2-base fp16 | ~500 MB | ~800 MB | 10-20s |
| **Florence-2-base int8** ← target | **~250 MB** | **~500-700 MB** | **8-15s** |

Constraint: Hetzner cloud, shared 2 vCPU (~50% available), 4 GB RAM (~2 GB available). Int8 verzija ustreza.

### Offline-first

- Initial download: 250 MB iz huggingface.co ob prvem zagonu
- Model se cached na disk (`~/.cache/huggingface/` ali konfigurabilen path)
- Po prvem downloadu **vse offline**: 0 outbound HTTP klicev, 0 telemetrije, 0 rate limitov
- Lahko pre-bake-amo v Docker image da izognemo runtime download

### API uporaba

```ts
import {
  AutoProcessor,
  AutoModelForCausalLM,
  RawImage
} from '@huggingface/transformers';

// Lazy load — naloži enkrat, drži v memoriji za vse nadaljnje requeste
const processor = await AutoProcessor.from_pretrained('onnx-community/Florence-2-base-ft');
const model = await AutoModelForCausalLM.from_pretrained(
  'onnx-community/Florence-2-base-ft',
  { dtype: 'int8' }
);

// Per-request
const image = await RawImage.read(imageBuffer);
const taskPrompt = '<OPEN_VOCABULARY_DETECTION>';
const textInput = taskPrompt + 'receipt';

const inputs = await processor(image, textInput);
const generatedIds = await model.generate({
  ...inputs,
  max_new_tokens: 1024,
  num_beams: 3,
});

const generatedText = processor.batch_decode(generatedIds, { skip_special_tokens: false })[0];
const result = processor.post_process_generation(generatedText, taskPrompt, image.size);
// result.bboxes: [[x1, y1, x2, y2], ...] — DEJANSKI piksel koordinati, ne 0-1000
// result.labels: ['receipt', 'receipt', ...]
```

**Pomembno**: output je v dejanskih pikslih, ne v normalizirani 0-1000 skali kot Gemini. Kar pomeni:
- Ni potrebe po multiplikaciji z dimenzijami slike
- Ni tveganja za inverzijo `[y_min, x_min, y_max, x_max]` formata
- Ni JSON parsinga, ni halucinacij

## Implementacija

### Faza 1: Dependency in PoC

1. **Dodaj dependency**
   ```bash
   npm install @huggingface/transformers
   ```

2. **Naredi standalone test skripto** v `scripts/test-florence2.ts`:
   - Prebere testno sliko računa
   - Zažene Florence-2 detekcijo
   - Izpiše bounding boxe + nariše rectangle overlay z `sharp` za vizualno verifikacijo
   - Meri RAM in čas inference

3. **Verificiraj na 3-5 realnih slikah** (single receipt, multi-receipt, tilted, low contrast)

### Faza 2: Integracija v image-splitter

1. **Nova datoteka** `src/services/florence2-detector.ts`:
   - Singleton ki drži loaded model (lazy init)
   - Funkcija `detectReceipts(buffer): Promise<BoundingBox[]>`
   - Output v istem `BoundingBox` formatu kot Gemini detector (`{x, y, width, height, rotation?}`), ampak v 0-1000 normalizirani skali za kompatibilnost s preostalim pipelineom
   - **Note o rotaciji**: Florence-2 vrne axis-aligned boxe brez rotacije. Trenutni pipeline rotacijo uporablja samo za nagnjene račune. Trenutno rotacijo postavimo na 0 in preverimo če je za naš use case dovolj. Če ne, dodamo separate rotation detection.

2. **Refactor `image-splitter.ts`**:
   - `detectBoundingBoxes()` najprej poskuša Florence-2
   - Če Florence-2 fail-a (OOM, model corruption, etc.) → padec na obstoječi Gemini detection kot fallback
   - Vrne unified `DetectionResult` z dodanim poljem `detectionMethod: 'florence2' | 'gemini'`

3. **Posodobi `splitMetadata`** v DB da vključuje `detectionMethod` za debugging.

### Faza 3: Pre-bake v Docker image

V `Dockerfile` dodaj build-time download:

```dockerfile
RUN node -e "
  import('@huggingface/transformers').then(async ({ AutoProcessor, AutoModelForCausalLM }) => {
    await AutoProcessor.from_pretrained('onnx-community/Florence-2-base-ft');
    await AutoModelForCausalLM.from_pretrained('onnx-community/Florence-2-base-ft', { dtype: 'int8' });
    console.log('Florence-2 cached');
  });
"
```

Tako je model v image-u, prvi job ne čaka na download.

### Faza 4: Worker thread (opcija)

Če blokiranje event loopa pri 8-15s inference postane problem (npr. več concurrent jobov):
- Premakni Florence-2 inference v `worker_threads`
- Glavni BullMQ worker delegate-a na thread
- Trenutno NE potrebno — BullMQ procesira po en job naenkrat

## Vpliv na obstoječi kod

| Datoteka | Sprememba |
|---|---|
| `package.json` | + `@huggingface/transformers` |
| `src/services/florence2-detector.ts` | **NOVA** — singleton za detekcijo |
| `src/services/image-splitter.ts` | Refactor `detectBoundingBoxes()` da prvo uporabi Florence-2 |
| `Dockerfile` | + RUN step za pre-bake modela |
| `src/workers/receiptProcessor.ts` | Brez sprememb |
| `src/ai/*` | Brez sprememb — Gemini chain ostane za analizo vsebine |

## Vpliv na fallback chain

### Pred (trenutno)

```
Detection (spatialReasoning required):
  gemini-2.5-flash  →  fail
```

### Po implementaciji

```
Detection:
  Florence-2 (lokalno)  →  gemini-2.5-flash  →  fail

Analysis (vision):
  gemini-2.5-flash  →  gemini-2.5-flash-lite  →  fail
  (nespremenjeno)
```

## Tradeoffi in tveganja

| Tveganje | Mitigacija |
|---|---|
| **OOM na 2GB RAM** | Int8 kvantizacija (~600 MB peak), monitoring; če pride → graceful fallback na Gemini |
| **Cold start ~10-15s ob prvem klicu** | Lazy load + pre-bake v Docker image |
| **Inference blokira event loop** | BullMQ ima en job naenkrat → ni problem; po potrebi worker_threads |
| **Florence-2 ne podpira rotacije** | Trenutno postavimo rotation=0; če nagnjen receipt fail-a, dodamo separate orientation step |
| **Kvaliteta na specifičnih slikah slabša od Gemini** | Gemini fallback ostane; A/B test na realnih slikah pred deploy |
| **Initial download fail** (npr. HF outage prvič) | Pre-bake v Docker image se izvede ob CI buildu, ne ob runtime |

## Verifikacija

1. **Funkcionalni test**: 5-10 realnih slik računov
   - Single receipt centered
   - Multi-receipt s presledki
   - Multi-receipt blizu skupaj
   - Tilted receipt (15-30°)
   - Low contrast / temno ozadje
2. **Resource test**: med inference monitoring `top` / `htop` na worker procesu
   - RAM peak < 1.5 GB
   - CPU usage 100% na 1 jedru ~10s, potem idle
3. **Latenca**: čas od `splitImage()` start do return < 30s na cold instance, < 20s warm
4. **A/B comparison**: poženi isti set slik skozi Florence-2 in Gemini, primerjaj IoU
5. **Failure mode**: simuliraj OOM → preveri da Gemini fallback prevzame brez crasha

## Stroški

| Komponenta | Cena |
|---|---|
| `@huggingface/transformers` package | Free, MIT |
| Florence-2 weights | Free, MIT |
| ONNX Runtime | Free, MIT |
| Hosting (obstoječi Hetzner) | €0 |
| Inference / API klici | €0 |
| Maintenance | npm update enkrat na čas |

**Skupaj: €0 dodatno**, operativno za vedno offline.

## Naslednji koraki

1. ✅ Plan dokumentiran (ta file)
2. ⬜ Faza 1: PoC v `scripts/test-florence2.ts`
3. ⬜ Faza 2: Integracija v `image-splitter.ts` z fallback
4. ⬜ Faza 3: Pre-bake v Docker
5. ⬜ Verifikacija na realnih slikah
6. ⬜ Production deploy
