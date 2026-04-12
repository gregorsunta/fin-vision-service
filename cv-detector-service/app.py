"""
FastAPI server exposing the Grounding DINO receipt detector over HTTP.

Endpoints:
  GET  /health      → liveness probe (returns ok only after model is loaded)
  POST /detect      → detect receipts in an uploaded image
"""

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from detector import ReceiptDetector

app = FastAPI(title="fin-vision CV detector", version="2.0")
# Module-level instantiation downloads model weights on first import.
# In production these are baked into the Docker image so this only loads
# them into RAM (~10-15 s on cold start).
detector = ReceiptDetector()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/detect")
async def detect(image: UploadFile = File(...)) -> JSONResponse:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image upload")

    try:
        result = detector.detect(image_bytes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Detection failed: {e}")

    return JSONResponse(
        {
            "boxes": [
                {
                    "x": b.x,
                    "y": b.y,
                    "width": b.width,
                    "height": b.height,
                    "rotation": b.rotation,
                    "confidence": b.confidence,
                }
                for b in result.boxes
            ],
            "imageWidth": result.image_width,
            "imageHeight": result.image_height,
            "debug": result.debug,
        }
    )
