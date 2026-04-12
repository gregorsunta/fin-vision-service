FROM python:3.12-slim

WORKDIR /app

# Pillow runtime deps (libjpeg, libpng) and ca-certs for HF downloads
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libjpeg62-turbo libpng16-16 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install torch CPU first from the dedicated CPU wheel index. This avoids
# pulling in the multi-GB CUDA libraries that ship with the default torch
# wheel from PyPI.
RUN pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download Grounding DINO Tiny weights into the image so cold start does
# not require network access. Cache lives at /root/.cache/huggingface.
ENV HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HOME=/root/.cache/huggingface
RUN python -c "from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; \
    AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-tiny'); \
    AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-tiny')"

COPY app.py detector.py ./

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
