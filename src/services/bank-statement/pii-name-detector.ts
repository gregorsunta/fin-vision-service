/**
 * HTTP client for the pii-detector sidecar (Presidio + spaCy).
 *
 * The sidecar runs as a separate container in docker-compose and exposes a
 * /redact-names endpoint that detects PERSON entities via spaCy NER and
 * replaces them with [OSEBA]. ORG and LOC entities are preserved — merchant
 * names must remain visible for AI categorisation.
 */

const DEFAULT_BASE_URL = 'http://localhost:8002';
// spaCy inference on CPU is fast (< 1 s per text); 10 s is generous headroom.
const TIMEOUT_MS = 10_000;

function getBaseUrl(): string {
  return process.env.PII_DETECTOR_URL ?? DEFAULT_BASE_URL;
}

export async function isPiiDetectorHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function redactPersonNames(text: string): Promise<{ text: string; persons: number }> {
  const res = await fetch(`${getBaseUrl()}/redact-names`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pii-detector returned ${res.status}: ${body || res.statusText}`);
  }

  return res.json() as Promise<{ text: string; persons: number }>;
}
