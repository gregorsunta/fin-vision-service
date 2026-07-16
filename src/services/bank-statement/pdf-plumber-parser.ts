/**
 * pdfplumber-based PDF table extractor.
 *
 * Calls the /extract-pdf endpoint on the pii-detector sidecar, which uses
 * pdfplumber's geometric table detection instead of manual Y-coordinate
 * clustering. Returns the extracted content as TSV-formatted text so column
 * boundaries are unambiguous to the AI parser.
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('services.bank-statement.pdf-plumber-parser');

const DEFAULT_BASE_URL = 'http://localhost:8002';
const TIMEOUT_MS = 60_000;

function getBaseUrl(): string {
  return process.env.PII_DETECTOR_URL ?? DEFAULT_BASE_URL;
}

interface PlumberPage {
  header: string;
  rows: string[][];
}

interface PlumberResult {
  pages: PlumberPage[];
  page_count: number;
}

export interface PlumberExtract {
  text: string;
  pageCount: number;
  hasTextLayer: boolean;
}

function pagesToText(result: PlumberResult): string {
  const parts: string[] = [];

  for (let i = 0; i < result.pages.length; i++) {
    const page = result.pages[i];
    if (i > 0) parts.push('\n\n--- PAGE BREAK ---\n\n');

    // Header block (contains IBAN, account holder, period, etc.)
    if (page.header.trim()) {
      parts.push(page.header.trim());
    }

    // Transaction table as TSV — tabs are unambiguous column separators.
    if (page.rows.length > 0) {
      parts.push('\n');
      for (const row of page.rows) {
        parts.push(row.join('\t'));
      }
    }
  }

  return parts.join('\n');
}

export async function extractPdfWithPlumber(buffer: Buffer): Promise<PlumberExtract> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: 'application/pdf' });
  formData.append('file', blob, 'statement.pdf');

  const res = await fetch(`${getBaseUrl()}/extract-pdf`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pdfplumber extract-pdf returned ${res.status}: ${body || res.statusText}`);
  }

  const data = (await res.json()) as PlumberResult;
  const text = pagesToText(data);
  const hasTextLayer = text.replace(/\s+/g, '').length > 50;

  log.debug({ pageCount: data.page_count, textLen: text.length, hasTextLayer }, 'pdfplumber extraction done');

  return { text, pageCount: data.page_count, hasTextLayer };
}
