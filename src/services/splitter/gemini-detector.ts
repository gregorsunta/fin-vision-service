import sharp from 'sharp';
import { AIService } from '../../ai/index.js';
import { createLogger } from '../../utils/logger.js';
import { mergeOverlappingBoxes } from './geometry.js';
import type { BoundingBox, DetectionResult } from './types.js';

const log = createLogger('services.splitter.gemini');

interface GeminiDetection {
  box_2d: [number, number, number, number]; // [y_min, x_min, y_max, x_max] in 0-1000 scale
  label: string;
  rotation_degrees?: number;
}

const DETECTION_PROMPT = `Detect each individual receipt in this image. Return a JSON array where each element has:
- "box_2d": [y_min, x_min, y_max, x_max] normalized to 0-1000
- "label": "receipt"
- "rotation_degrees": the clockwise tilt of the receipt (0 if upright, positive = clockwise, negative = counter-clockwise; range -45 to 45)

The bounding box must tightly enclose the physical receipt paper itself — NOT the entire image. Each receipt is a distinct piece of paper; only the area covered by that paper should be inside the box.

Make sure the box vertically extends from the very TOP edge of the receipt paper (header/logo) all the way to the very BOTTOM edge (total, barcode, or footer). Do not crop the top or bottom of the receipt. Vertically, prefer a slightly larger box over a tight one.

For tilted receipts: the axis-aligned box must contain all four corners of the rotated receipt paper, and "rotation_degrees" should reflect the tilt angle.

SEPARATING MULTIPLE RECEIPTS — VERY IMPORTANT:
Two receipts that are placed close together but have ANY visible gap between them (background showing through, even a thin strip) are SEPARATE receipts. Each must get its own bounding box. Do NOT merge them into one box just because they are near each other.

Signs that you are looking at two separate receipts (not one):
- A visible strip of background/table between them
- A clear edge of paper followed by background followed by another edge of paper
- Different paper widths, lengths, colors, or print styles
- Two distinct merchant headers/logos
- Two distinct totals or two distinct barcodes/footers

If you are unsure whether something is one receipt or two, return TWO separate boxes. It is much better to over-split than to merge two receipts into one box.

WHAT COUNTS AS A RECEIPT:
Only detect objects that are clearly physical paper receipts with all three of the following visible:
1. A store/merchant name or header
2. At least one item with a price
3. A total amount

DO NOT detect: blank paper, envelopes, napkins, books, business cards, hands, wallets, packaging, or any object that is not a printed receipt. If an object is white or paper-like but lacks visible price text and a total, do NOT include it.

Never return masks or code fencing. Return one detection per distinct receipt.`;

async function detectMimeType(imageBuffer: Buffer): Promise<string> {
  const metadata = await sharp(imageBuffer).metadata();
  const formatMap: Record<string, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    tiff: 'image/tiff',
  };
  return formatMap[metadata.format || ''] || 'image/jpeg';
}

export async function detectBoundingBoxesGemini(
  imageBuffer: Buffer,
  aiService: AIService,
): Promise<DetectionResult> {
  const mimeType = await detectMimeType(imageBuffer);

  try {
    const result = await aiService.generate({
      prompt: DETECTION_PROMPT,
      images: [{ data: imageBuffer, mimeType }],
      requireVision: true,
      requireSpatialReasoning: true,
    });

    const rawResponse = result.text;
    let responseText = rawResponse;
    log.debug({ provider: result.provider, preview: responseText.substring(0, 500) }, 'AI raw response');

    // Strip markdown code fences
    const jsonRegex = /```(?:json)?\n?([\s\S]*?)\n?```/;
    const match = responseText.match(jsonRegex);
    if (match && match[1]) {
      responseText = match[1].trim();
      log.debug({ preview: responseText.substring(0, 500) }, 'cleaned JSON response');
    }

    const parsed = JSON.parse(responseText);
    const detections: GeminiDetection[] = Array.isArray(parsed) ? parsed : [parsed];

    const rawBoundingBoxes: BoundingBox[] = detections
      .filter((d) => d.box_2d && Array.isArray(d.box_2d) && d.box_2d.length === 4)
      .map((d) => {
        let [yMin, xMin, yMax, xMax] = d.box_2d;

        yMin = Math.max(0, Math.min(1000, yMin));
        xMin = Math.max(0, Math.min(1000, xMin));
        yMax = Math.max(0, Math.min(1000, yMax));
        xMax = Math.max(0, Math.min(1000, xMax));

        if (yMin > yMax) [yMin, yMax] = [yMax, yMin];
        if (xMin > xMax) [xMin, xMax] = [xMax, xMin];

        log.debug(
          { raw: d.box_2d, x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin },
          'box_2d normalized',
        );

        return {
          x: xMin,
          y: yMin,
          width: xMax - xMin,
          height: yMax - yMin,
          rotation: d.rotation_degrees ?? 0,
        };
      })
      .filter((box) => box.width > 0 && box.height > 0);

    log.info({ count: rawBoundingBoxes.length, provider: result.provider }, 'detected raw bounding boxes');

    const mergedBoundingBoxes = mergeOverlappingBoxes(rawBoundingBoxes);
    if (mergedBoundingBoxes.length < rawBoundingBoxes.length) {
      log.info(
        { before: rawBoundingBoxes.length, after: mergedBoundingBoxes.length },
        'merged overlapping duplicate boxes',
      );
    }

    return {
      rawResponse,
      rawBoundingBoxes,
      mergedBoundingBoxes,
      provider: result.provider,
      model: result.model,
    };
  } catch (error) {
    log.error({ err: error }, 'error calling AI service for bounding boxes');
    if (error instanceof SyntaxError && error.message.includes('JSON.parse')) {
      log.error('AI service did not return valid JSON');
    }
    throw new Error('Failed to get bounding boxes from AI service.', { cause: error });
  }
}
