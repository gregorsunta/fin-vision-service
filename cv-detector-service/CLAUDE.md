# cv-detector-service — Python FastAPI sidecar

> **Opozorilo za LLM:** to je **Python** podservis v Node/TS monorepu. Ne uporabljaj npm/tsc konvencij — uporabljaj `pip`, `python`, `uvicorn`. Ne edit-aj tukajšnje kode, če urejaš parent Node servis (in obratno).

## Namen

Zaznava bounding boxov računov na uploadanih slikah preko zero-shot object detection (Grounding DINO Tiny, ONNX/PyTorch). Parent service (`src/services/image-splitter.ts`) to kliče preko HTTP; ob nedostopnosti uporabi Gemini LLM kot fallback.

## Stack

- Python 3.12, FastAPI + Uvicorn
- Model: `IDEA-Research/grounding-dino-tiny` (172M params)
- HuggingFace `transformers==4.46.3`, `torch==2.5.1` (CPU-only wheel)
- Model weights **pre-baked v Docker image** (no runtime HF download)
- Stateless; cold start ~10–15 s (model load), inference ~5–15 s per request

## API kontrakt

### `GET /health`
- Returns `200 {"status": "ok"}` če je servis živ. Docker healthcheck ga polls.
- Model load NE blokira healthchecka; prva `POST /detect` po startu lahko traja dlje.

### `POST /detect`
- `multipart/form-data` z `file` field-om `image` (JPEG/PNG/WEBP).
- Response:
  ```json
  {
    "boxes": [
      { "x": 0-1000, "y": 0-1000, "width": 0-1000, "height": 0-1000,
        "rotation": 0.0, "confidence": 0.0-1.0 }
    ],
    "imageWidth": <px>,
    "imageHeight": <px>,
    "debug": { "model": "...", "query": "a receipt.", "thresholds": {...}, "filter_stats": {...} }
  }
  ```
- **Koordinatni sistem: normaliziran 0–1000** (konceptualni 1000×1000 grid, neodvisen od pikslov). Parent naredi piksel konverzijo v `image-splitter.ts`.
- `rotation` je vedno 0 (axis-aligned bounding boxes).

## Tuning surface (env)

| Var | Default | Pomen |
|---|---|---|
| `GROUNDING_MODEL` | `IDEA-Research/grounding-dino-tiny` | HF model ID (prepisan v Dockerfile-u pre-download stage-u) |
| `GD_BOX_THRESHOLD` | `0.20` | Min detection confidence. Nižje → več detekcij (več false positivov). |
| `GD_TEXT_THRESHOLD` | `0.20` | Min text-alignment confidence |
| `GD_MAX_AREA_FRACTION` | `0.70` | Max delež slike, ki ga lahko pokriva en box (prepreči catch-all detekcije) |
| `GD_NMS_IOU` | `0.30` | IoU prag za NMS deduplikacijo. Višje → obdrži bolj prekrivne bokse. |
| `TORCH_NUM_THREADS` | `2` | CPU niti; manj = manj RAM-a, počasnejše |
| `HF_HUB_DISABLE_TELEMETRY` | `1` | Disable HF telemetry |

### Pragovi kako tuning-i

- **Pogosto zgrešene detekcije (recall težava):** zniži `GD_BOX_THRESHOLD` (npr. na 0.15).
- **Preveč "sosednih" boxov na istem računu:** zvišaj `GD_NMS_IOU` (npr. na 0.45) ali znižaj `GD_MAX_AREA_FRACTION`.
- **Full-scene catch-all detekcije:** zniži `GD_MAX_AREA_FRACTION` (npr. na 0.55).

## Pasti

- **Provider naming mismatch**: parent (`image-splitter.ts`) logira `provider="opencv"` čeprav je model Grounding DINO. Legacy ime; popravi ob naslednjem refactorju splitterja.
- **Broad `except Exception`** v `app.py` → 500 maskira pravi razlog; pri debug-u poglej container logs direktno (`docker logs cv-detector`).
- **Hardcoded text query**: `TEXT_QUERY = "a receipt."` v `detector.py`. Sprememba zahteva code edit + rebuild image-a.
- **Module-level model load**: `detector = ReceiptDetector()` na module scope-u (app.py); reimport sproži re-load.
- **Ne uporablja `logging` modula**, samo `print()` — za production log aggregation treba refactor-ati.

## Fallback vedenje (parent)

1. Parent `isCvDetectorHealthy()` pinga `/health` (2s timeout).
2. Če OK → `POST /detect` (60s timeout, do refactor-ja hardcoded).
3. Če 0 boxov ALI unhealthy → fallback na Gemini vision (hitrejše ampak rate-limitano).

Parent to zapisuje v `receipt_uploads.split_metadata.provider` + `.model` za audit trail.

## Lokalna iteracija

```bash
cd cv-detector-service
docker build -t cv-detector .
docker run --rm -p 8001:8000 \
  -e GD_BOX_THRESHOLD=0.15 \
  cv-detector
curl -X POST -F "image=@/path/to/receipt.jpg" http://localhost:8001/detect | jq
```

Za ekspres iteracijo brez Docker rebuild-a:

```bash
cd cv-detector-service
pip install -r requirements.txt
uvicorn app:app --reload --port 8001
```

(model load ~10s; `--reload` restarta ob spremembi kode → vsak reload znova naloži model)

## Povezane datoteke

- `src/services/cv-detector.ts` — TS HTTP client (health + detect)
- `src/services/image-splitter.ts` — orchestrator, fallback logika
- `docker-compose.yml`, `docker-compose.prod.yml` — service definition + env override
- `Dockerfile` — multi-stage build, pre-baked model weights

## Todo

- Zamenjaj `print()` z `logging` modulom (strukturirani JSON za log agregacijo).
- Dodaj explicit input validation (max file size, format whitelist).
- Parametriziraj `TEXT_QUERY`.
- Popravi parent misleading `provider="opencv"` → `"grounding-dino"`.
