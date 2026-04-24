import { ImageAnnotatorClient } from '@google-cloud/vision';
import { getTesseractWorker } from '../../utils/tesseract.js';
import { createLogger } from '../../utils/logger.js';
import { preprocessForOcr } from './preprocess.js';

const log = createLogger('services.ocr.pipeline');

/**
 * Merges OCR outputs from multiple engines into a single deduplicated text.
 * Lines are normalized for comparison (whitespace collapsed, lowercased) but
 * original casing is preserved in the output.
 */
export function mergeOcrTexts(...sources: (string | null)[]): string | null {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const key = line.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(line);
    }
  }
  return merged.length > 0 ? merged.join('\n') : null;
}

/**
 * Complementary Tesseract engine — different algorithm to Vision, catches
 * missed text. Lazy-loads the shared worker. Returns null on failure.
 */
export async function extractTextWithTesseract(image: Buffer): Promise<string | null> {
  if (process.env.OCR_TESSERACT === 'false') {
    return null;
  }
  try {
    const worker = await getTesseractWorker();
    const result = await worker.recognize(image);
    const text = result.data.text?.trim() || null;
    if (text) {
      log.debug({ charCount: text.length }, 'Tesseract extracted text');
    }
    return text;
  } catch (error) {
    log.warn({ err: error }, 'Tesseract OCR failed');
    return null;
  }
}

/**
 * Multi-engine OCR pipeline (Vision documentTextDetection → Vision textDetection
 * fallback → Tesseract). Outputs from all engines are merged/deduplicated so
 * downstream cross-validation has maximum recall.
 */
export async function extractTextWithVision(
  visionClient: ImageAnnotatorClient,
  image: Buffer,
): Promise<string | null> {
  const languageHints = ['sl', 'hr', 'en', 'de'];
  const processedImage = await preprocessForOcr(image);
  let visionText: string | null = null;

  try {
    const [result] = await visionClient.documentTextDetection({
      image: { content: processedImage },
      imageContext: { languageHints },
    });
    visionText = result.fullTextAnnotation?.text ?? null;

    if (!visionText || visionText.length < 100) {
      log.warn(
        { charCount: visionText?.length ?? 0 },
        'documentTextDetection returned little text, retrying with textDetection',
      );
      const [retry] = await visionClient.textDetection({
        image: { content: processedImage },
        imageContext: { languageHints },
      });
      const retryText = retry.textAnnotations?.[0]?.description ?? null;
      if (retryText && retryText.length > (visionText?.length ?? 0)) {
        visionText = retryText;
      }
    }

    if (visionText) {
      log.debug({ charCount: visionText.length }, 'Cloud Vision extracted text');
    }
  } catch (error) {
    log.warn({ err: error }, 'Cloud Vision OCR failed, falling back to other engines');
  }

  const tesseractText = await extractTextWithTesseract(processedImage);
  return mergeOcrTexts(visionText, tesseractText);
}

export interface ExtractTextDebugResult {
  visionDocument: string | null;
  visionText: string | null;
  tesseract: string | null;
  merged: string | null;
  charCounts: { visionDocument: number; visionText: number; tesseract: number; merged: number };
}

/**
 * Debug variant: runs all engines separately and returns each output plus
 * the merged result. Used by the /ocr/test dev endpoint.
 */
export async function extractTextDebug(
  visionClient: ImageAnnotatorClient,
  image: Buffer,
  preprocess: boolean,
): Promise<ExtractTextDebugResult> {
  const languageHints = ['sl', 'hr', 'en', 'de'];
  const processedImage = preprocess ? await preprocessForOcr(image) : image;

  const [documentResult, textResult, tesseractText] = await Promise.allSettled([
    visionClient.documentTextDetection({
      image: { content: processedImage },
      imageContext: { languageHints },
    }),
    visionClient.textDetection({
      image: { content: processedImage },
      imageContext: { languageHints },
    }),
    extractTextWithTesseract(processedImage),
  ]);

  const visionDocument =
    documentResult.status === 'fulfilled'
      ? (documentResult.value[0].fullTextAnnotation?.text ?? null)
      : null;
  const visionText =
    textResult.status === 'fulfilled'
      ? (textResult.value[0].textAnnotations?.[0]?.description ?? null)
      : null;
  const tesseract = tesseractText.status === 'fulfilled' ? tesseractText.value : null;
  const merged = mergeOcrTexts(visionDocument, visionText, tesseract);

  return {
    visionDocument,
    visionText,
    tesseract,
    merged,
    charCounts: {
      visionDocument: visionDocument?.length ?? 0,
      visionText: visionText?.length ?? 0,
      tesseract: tesseract?.length ?? 0,
      merged: merged?.length ?? 0,
    },
  };
}
