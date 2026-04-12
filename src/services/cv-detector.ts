/**
 * HTTP client for the OpenCV-based receipt detector sidecar.
 *
 * The sidecar (cv-detector-service/) runs as a separate container in
 * docker-compose and exposes a /detect endpoint that accepts an image and
 * returns axis-aligned bounding boxes (with rotation metadata) in 0-1000
 * normalized coordinates — same format used by the existing pipeline.
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface CvDetectionResult {
  boundingBoxes: BoundingBox[];
  imageWidth: number;
  imageHeight: number;
  /** Average confidence score across all detected boxes (0-1). */
  meanConfidence: number;
  debug?: unknown;
}

const DEFAULT_BASE_URL = 'http://localhost:8001';
// Grounding DINO Tiny inference on CPU takes ~5-15 s per image. Allow some
// headroom for network and queue delays.
const DEFAULT_TIMEOUT_MS = 60_000;

function getBaseUrl(): string {
  return process.env.CV_DETECTOR_URL || DEFAULT_BASE_URL;
}

export async function isCvDetectorHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function detectReceiptsCV(imageBuffer: Buffer): Promise<CvDetectionResult> {
  const formData = new FormData();
  // Sidecar expects a multipart `image` file. The filename and mime type are
  // not used by OpenCV decode (it sniffs the bytes), so a generic stub is fine.
  const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'application/octet-stream' });
  formData.append('image', blob, 'upload.bin');

  const res = await fetch(`${getBaseUrl()}/detect`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CV detector returned ${res.status}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as {
    boxes: Array<{ x: number; y: number; width: number; height: number; rotation?: number; confidence?: number }>;
    imageWidth: number;
    imageHeight: number;
    debug?: unknown;
  };

  const boundingBoxes: BoundingBox[] = data.boxes.map((b) => ({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    rotation: b.rotation ?? 0,
  }));

  const meanConfidence = data.boxes.length > 0
    ? data.boxes.reduce((sum, b) => sum + (b.confidence ?? 0), 0) / data.boxes.length
    : 0;

  return {
    boundingBoxes,
    imageWidth: data.imageWidth,
    imageHeight: data.imageHeight,
    meanConfidence,
    debug: data.debug,
  };
}
