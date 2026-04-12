import sharp from 'sharp';
import { AIService, getAIService } from '../ai/index.js';
import { detectReceiptsCV, isCvDetectorHealthy } from './cv-detector.js';

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

interface GeminiDetection {
  box_2d: [number, number, number, number]; // [y_min, x_min, y_max, x_max] in 0-1000 scale
  label: string;
  rotation_degrees?: number;
}

interface DetectionResult {
  rawResponse: string;
  rawBoundingBoxes: BoundingBox[];
  mergedBoundingBoxes: BoundingBox[];
  provider: string;
  model: string;
}

interface SplitImageResult {
  images: Buffer[];
  splitMetadata?: {
    rawResponse: string;
    rawBoundingBoxes: BoundingBox[];
    mergedBoundingBoxes: BoundingBox[];
    provider: string;
    model: string;
    detectedCount: number;
    mergedCount: number;
  };
}

export class ImageSplitterService {
  private aiService: AIService;

  constructor(aiService?: AIService) {
    this.aiService = aiService || getAIService();
  }

  public async splitImage(imageBuffer: Buffer): Promise<SplitImageResult> {
    try {
      // Image is already EXIF-normalized by compressToWebP() at upload time — no .rotate() needed.
      // Try the OpenCV sidecar first; fall back to Gemini if it's unhealthy or returns no boxes.
      const detection = await this.detectBoundingBoxesWithFallback(imageBuffer);

      const result: SplitImageResult = {
        images: [],
        splitMetadata: {
          rawResponse: detection.rawResponse,
          rawBoundingBoxes: detection.rawBoundingBoxes,
          mergedBoundingBoxes: detection.mergedBoundingBoxes,
          provider: detection.provider,
          model: detection.model,
          detectedCount: detection.rawBoundingBoxes.length,
          mergedCount: detection.mergedBoundingBoxes.length,
        },
      };

      const detectedBoundingBoxes = detection.mergedBoundingBoxes;

      if (detectedBoundingBoxes.length === 0) {
        console.warn('AI did not detect any distinct receipts. Returning the original image.');
        result.images.push(imageBuffer);
        return result;
      }

      const { width: imageWidth, height: imageHeight } = await sharp(imageBuffer).metadata();
      if (!imageWidth || !imageHeight) {
        throw new Error('Could not get image dimensions');
      }

      console.log(`Image dimensions: ${imageWidth}x${imageHeight}`);
      console.log(`Processing ${detectedBoundingBoxes.length} detected bounding boxes...`);

      for (let i = 0; i < detectedBoundingBoxes.length; i++) {
        const box = detectedBoundingBoxes[i];
        const rotation = box.rotation ?? 0;
        console.log(`\nBox ${i + 1} - Normalized coordinates:`, box);

        const pixelX = Math.round((box.x / 1000) * imageWidth);
        const pixelY = Math.round((box.y / 1000) * imageHeight);
        const pixelWidth = Math.round((box.width / 1000) * imageWidth);
        const pixelHeight = Math.round((box.height / 1000) * imageHeight);

        console.log(`Box ${i + 1} - Pixels: x=${pixelX}, y=${pixelY}, width=${pixelWidth}, height=${pixelHeight}`);

        const paddingFactor = Math.abs(rotation) > 5 ? 0.15 : 0.05;
        const paddingWidth = Math.round(pixelWidth * paddingFactor);
        const paddingHeight = Math.round(pixelHeight * paddingFactor);

        const left = Math.max(0, pixelX - paddingWidth);
        const top = Math.max(0, pixelY - paddingHeight);
        const width = pixelWidth + (paddingWidth * 2);
        const height = pixelHeight + (paddingHeight * 2);

        if (left >= imageWidth || top >= imageHeight) {
          console.warn('Skipping bounding box outside image bounds:', box);
          continue;
        }

        const extractWidth = Math.min(width, imageWidth - left);
        const extractHeight = Math.min(height, imageHeight - top);

        if (extractWidth <= 0 || extractHeight <= 0) {
          console.warn('Skipping bounding box with zero/negative dimensions after clamping:', { box, extractWidth, extractHeight });
          continue;
        }

        console.log(`Box ${i + 1} - Extracting: left=${left}, top=${top}, width=${extractWidth}, height=${extractHeight}`);

        let croppedImageBuffer = await sharp(imageBuffer)
          .extract({ left, top, width: extractWidth, height: extractHeight })
          .toBuffer();

        if (Math.abs(rotation) > 2) {
          console.log(`Box ${i + 1}: Correcting ${rotation}° tilt`);
          croppedImageBuffer = await sharp(croppedImageBuffer)
            .rotate(-rotation, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .toBuffer();
        }

        result.images.push(croppedImageBuffer);
      }

      return result;
    } catch (error) {
      console.error('Error in splitImage method. Original error:', error);
      // Wrap but preserve the original error so callers can detect rate limits etc.
      throw new Error('Could not split the image using Gemini.', { cause: error });
    }
  }

  /**
   * Tries the OpenCV sidecar first. If it's unreachable, returns 0 boxes, or
   * throws, falls back to the Gemini-based detector.
   */
  private async detectBoundingBoxesWithFallback(imageBuffer: Buffer): Promise<DetectionResult> {
    const cvHealthy = await isCvDetectorHealthy();
    if (cvHealthy) {
      try {
        const cvResult = await detectReceiptsCV(imageBuffer);
        if (cvResult.boundingBoxes.length > 0) {
          console.log(`[splitter] OpenCV detector: ${cvResult.boundingBoxes.length} box(es), mean confidence ${cvResult.meanConfidence.toFixed(2)}`);
          return {
            rawResponse: JSON.stringify(cvResult.debug ?? {}),
            rawBoundingBoxes: cvResult.boundingBoxes,
            mergedBoundingBoxes: cvResult.boundingBoxes,
            provider: 'opencv',
            model: 'opencv-canny-contours',
          };
        }
        console.warn('[splitter] OpenCV detector returned 0 boxes — falling back to Gemini');
      } catch (err) {
        console.warn('[splitter] OpenCV detector failed, falling back to Gemini:', err);
      }
    } else {
      console.warn('[splitter] OpenCV sidecar unhealthy, using Gemini directly');
    }

    return this.detectBoundingBoxes(imageBuffer);
  }

  private async detectBoundingBoxes(imageBuffer: Buffer): Promise<DetectionResult> {
    const mimeType = await this.detectMimeType(imageBuffer);

    const prompt = `Detect each individual receipt in this image. Return a JSON array where each element has:
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

Never return masks or code fencing. Return one detection per distinct receipt.`;

    try {
      const result = await this.aiService.generate({
        prompt,
        images: [{ data: imageBuffer, mimeType }],
        requireVision: true,
        requireSpatialReasoning: true,
      });

      const rawResponse = result.text;
      let responseText = rawResponse;
      console.log(`${result.provider} raw response:`, responseText);

      // Clean markdown code fences if present
      const jsonRegex = /```(?:json)?\n?([\s\S]*?)\n?```/;
      const match = responseText.match(jsonRegex);
      if (match && match[1]) {
        responseText = match[1].trim();
        console.log('Cleaned JSON response:', responseText);
      }

      const parsed = JSON.parse(responseText);
      const detections: GeminiDetection[] = Array.isArray(parsed) ? parsed : [parsed];

      // Validate and convert from Gemini's native box_2d [y_min, x_min, y_max, x_max] to our BoundingBox format
      const rawBoundingBoxes: BoundingBox[] = detections
        .filter(d => d.box_2d && Array.isArray(d.box_2d) && d.box_2d.length === 4)
        .map(d => {
          let [yMin, xMin, yMax, xMax] = d.box_2d;

          // Clamp all values to valid 0-1000 range
          yMin = Math.max(0, Math.min(1000, yMin));
          xMin = Math.max(0, Math.min(1000, xMin));
          yMax = Math.max(0, Math.min(1000, yMax));
          xMax = Math.max(0, Math.min(1000, xMax));

          // Auto-correct if min/max are swapped
          if (yMin > yMax) [yMin, yMax] = [yMax, yMin];
          if (xMin > xMax) [xMin, xMax] = [xMax, xMin];

          console.log(`  box_2d raw: [${d.box_2d.join(', ')}] → normalized: x=${xMin}, y=${yMin}, w=${xMax - xMin}, h=${yMax - yMin}`);

          return {
            x: xMin,
            y: yMin,
            width: xMax - xMin,
            height: yMax - yMin,
            rotation: d.rotation_degrees ?? 0,
          };
        })
        .filter(box => box.width > 0 && box.height > 0);

      console.log(`Detected ${rawBoundingBoxes.length} raw bounding box(es) from ${result.provider} response`);

      const mergedBoundingBoxes = this.mergeOverlappingBoxes(rawBoundingBoxes);
      if (mergedBoundingBoxes.length < rawBoundingBoxes.length) {
        console.log(`Merged ${rawBoundingBoxes.length} boxes down to ${mergedBoundingBoxes.length} (removed overlapping duplicates)`);
      }

      return {
        rawResponse,
        rawBoundingBoxes,
        mergedBoundingBoxes,
        provider: result.provider,
        model: result.model,
      };
    } catch (error) {
      console.error('Error calling AI service for bounding boxes. Original error:', error);
      if (error instanceof SyntaxError && error.message.includes('JSON.parse')) {
        console.error('AI service did not return valid JSON. The raw response is logged above.');
      }
      throw new Error('Failed to get bounding boxes from AI service.', { cause: error });
    }
  }

  /**
   * Merges bounding boxes that overlap significantly (IoU > threshold),
   * preventing duplicate crops of the same receipt.
   */
  private mergeOverlappingBoxes(boxes: BoundingBox[], iouThreshold = 0.3): BoundingBox[] {
    if (boxes.length <= 1) return boxes;

    // Track which boxes have been merged into another
    const merged = new Array<boolean>(boxes.length).fill(false);
    const result: BoundingBox[] = [];

    for (let i = 0; i < boxes.length; i++) {
      if (merged[i]) continue;

      let current = boxes[i];

      for (let j = i + 1; j < boxes.length; j++) {
        if (merged[j]) continue;

        const iou = this.computeIoU(current, boxes[j]);
        if (iou > iouThreshold) {
          console.log(`Boxes ${i} and ${j} overlap (IoU=${iou.toFixed(2)}), merging`);
          // Merge by taking the union (largest enclosing box)
          current = this.unionBox(current, boxes[j]);
          merged[j] = true;
        }
      }

      result.push(current);
    }

    return result;
  }

  private computeIoU(a: BoundingBox, b: BoundingBox): number {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);

    const intersectionWidth = Math.max(0, x2 - x1);
    const intersectionHeight = Math.max(0, y2 - y1);
    const intersection = intersectionWidth * intersectionHeight;

    if (intersection === 0) return 0;

    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    const union = areaA + areaB - intersection;

    return intersection / union;
  }

  private unionBox(a: BoundingBox, b: BoundingBox): BoundingBox {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.width, b.x + b.width);
    const y2 = Math.max(a.y + a.height, b.y + b.height);
    const rotation = ((a.rotation ?? 0) + (b.rotation ?? 0)) / 2;
    return { x, y, width: x2 - x, height: y2 - y, rotation };
  }

  private async detectMimeType(imageBuffer: Buffer): Promise<string> {
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
}