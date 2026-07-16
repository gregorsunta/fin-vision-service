import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLogger } from '../../utils/logger.js';
import { findIbanInText, detectBankName } from './iban-utils.js';
import { extractPdfWithPlumber } from './pdf-plumber-parser.js';
import type { ParsedStatement } from './types.js';

const log = createLogger('services.bank-statement.pdf-native-parser');

export interface NativePdfExtract {
  text: string;
  pageCount: number;
  hasTextLayer: boolean;
  info?: ParsedStatement;
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

// Tolerances tuned for typical A4 bank statements (12pt body text). Items
// whose Y-centre lies within ROW_TOLERANCE pt of each other belong to the
// same row. X gaps inside a row are translated into proportional whitespace
// so that empty columns (e.g. an absent "Money in" cell on an outgoing
// transaction) survive into the AI prompt as visible whitespace rather than
// collapsing — without this the AI cannot tell which column a number belongs
// to when adjacent cells are blank.
const ROW_TOLERANCE = 3;
const PT_PER_SPACE = 3; // approx width of a space char at 12pt
const MIN_INTRA_WORD_GAP = 1.5;

/**
 * Reconstructs the textual structure of a single page from positioned text
 * items. Bank statements depend heavily on tabular layout; flattening to a
 * single line stream (which `pdf-parse` does) routinely scrambles which
 * amount belongs to which row, so we instead:
 *
 *   1. Cluster items into rows by Y coordinate (top-down).
 *   2. Sort each row left-to-right by X.
 *   3. Insert multi-space separators on large X gaps so column boundaries
 *      survive into the AI prompt.
 */
function reconstructPageText(items: PositionedItem[]): string {
  if (items.length === 0) return '';

  // PDF Y origin is bottom-left; sort descending Y for top-down reading order.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: PositionedItem[][] = [];
  for (const item of sorted) {
    const trimmed = item.str.trim();
    if (!trimmed) continue;
    const current = rows[rows.length - 1];
    if (current && Math.abs(current[0].y - item.y) <= ROW_TOLERANCE) {
      current.push(item);
    } else {
      rows.push([item]);
    }
  }

  const lines: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let line = '';
    let prevEndX = -Infinity;
    for (let i = 0; i < row.length; i++) {
      const item = row[i];
      if (i === 0) {
        line = item.str;
      } else {
        const gap = item.x - prevEndX;
        let sep = '';
        if (gap >= MIN_INTRA_WORD_GAP) {
          // Proportional padding: a 30pt gap (an empty column) becomes ~10
          // spaces, a 4pt gap (between words) becomes 1 space. Capped to keep
          // the prompt manageable on extreme outliers.
          const spaces = Math.min(40, Math.max(1, Math.round(gap / PT_PER_SPACE)));
          sep = ' '.repeat(spaces);
        }
        line += sep + item.str;
      }
      prevEndX = item.x + item.width;
    }
    const collapsed = line.replace(/[ \t]+$/g, '');
    if (collapsed) lines.push(collapsed);
  }
  return lines.join('\n');
}

/**
 * Extracts plain text from a native (non-scanned) PDF.
 *
 * Tries pdfplumber (Python sidecar) first — it detects column boundaries from
 * line geometry and returns TSV output, which is more reliable for complex bank
 * statement layouts. Falls back to pdfjs-dist positional reconstruction if the
 * sidecar is unavailable.
 */
export async function extractNativePdf(buffer: Buffer): Promise<NativePdfExtract> {
  try {
    const plumber = await extractPdfWithPlumber(buffer);
    if (plumber.hasTextLayer) {
      log.info({ pageCount: plumber.pageCount, textLen: plumber.text.length }, 'pdf extracted via pdfplumber');
      const iban = findIbanInText(plumber.text) ?? undefined;
      const bankName = iban ? detectBankName(iban) : undefined;
      return {
        text: plumber.text,
        pageCount: plumber.pageCount,
        hasTextLayer: true,
        info: {
          parser: 'pdfplumber',
          parserVersion: '1',
          account: { iban, bankName, currency: 'EUR' },
          period: {},
          transactions: [],
          warnings: [],
          extra: { pageCount: plumber.pageCount, textPreview: plumber.text.slice(0, 500) },
        },
      };
    }
  } catch (err) {
    log.warn({ err }, 'pdfplumber unavailable, falling back to pdfjs');
  }

  return extractWithPdfjs(buffer);
}

async function extractWithPdfjs(buffer: Buffer): Promise<NativePdfExtract> {
  // pdfjs-dist mutates the input; pass a fresh Uint8Array view.
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    // No fonts/CMaps needed for text extraction; suppress noisy console output.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  const pageCount = doc.numPages;
  const pageTexts: string[] = [];

  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        const positioned: PositionedItem[] = [];
        for (const item of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
          if (typeof item.str !== 'string' || !item.transform) continue;
          // transform = [a, b, c, d, e, f] — for pure translations and
          // left-to-right text, e is X and f is Y in PDF user-space units.
          positioned.push({
            str: item.str,
            x: item.transform[4] ?? 0,
            y: item.transform[5] ?? 0,
            width: typeof item.width === 'number' ? item.width : 0,
          });
        }
        pageTexts.push(reconstructPageText(positioned));
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }

  const text = pageTexts.join('\n\n--- PAGE BREAK ---\n\n');
  const hasTextLayer = text.replace(/\s+/g, '').length > 50;

  log.debug({ pageCount, textLen: text.length, hasTextLayer }, 'pdf text extraction');

  if (!hasTextLayer) {
    return { text, pageCount, hasTextLayer: false };
  }

  const iban = findIbanInText(text) ?? undefined;
  const bankName = iban ? detectBankName(iban) : undefined;

  return {
    text,
    pageCount,
    hasTextLayer: true,
    info: {
      parser: 'native-pdf',
      parserVersion: '2',
      account: { iban, bankName, currency: 'EUR' },
      period: {},
      transactions: [],
      warnings: [],
      extra: { pageCount, textPreview: text.slice(0, 500) },
    },
  };
}
