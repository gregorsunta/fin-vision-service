import sharp from 'sharp';
import { AIService, getAIService } from '../ai/index.js';

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GeminiDetection {
  box_2d: [number, number, number, number]; // [y_min, x_min, y_max, x_max] in 0-1000 scale
  label: string;
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
      // Normalize EXIF orientation so dimensions and pixel coordinates are consistent
      imageBuffer = Buffer.from(await sharp(imageBuffer).rotate().toBuffer());

      const detection = await this.detectBoundingBoxes(imageBuffer);

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
        console.log(`\nBox ${i + 1} - Normalized coordinates:`, box);

        const pixelX = Math.round((box.x / 1000) * imageWidth);
        const pixelY = Math.round((box.y / 1000) * imageHeight);
        const pixelWidth = Math.round((box.width / 1000) * imageWidth);
        const pixelHeight = Math.round((box.height / 1000) * imageHeight);

        console.log(`Box ${i + 1} - Pixels: x=${pixelX}, y=${pixelY}, width=${pixelWidth}, height=${pixelHeight}`);

        const paddingWidth = Math.round(pixelWidth * 0.05);
        const paddingHeight = Math.round(pixelHeight * 0.05);

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

        const croppedImageBuffer = await sharp(imageBuffer)
          .extract({ left, top, width: extractWidth, height: extractHeight })
          .toBuffer();
        result.images.push(croppedImageBuffer);
      }

      return result;
    } catch (error) {
      console.error('Error in splitImage method. Original error:', error);
      throw new Error('Could not split the image using Gemini.');
    }
  }

  private async detectBoundingBoxes(imageBuffer: Buffer): Promise<DetectionResult> {
    const mimeType = await this.detectMimeType(imageBuffer);

    const prompt = `Detect all individual receipts in this image. Return bounding boxes as a JSON array with labels. Never return masks or code fencing. If there are multiple receipts, detect each one separately.`;

    try {
      const result = await this.aiService.generate({
        prompt,
        images: [{ data: imageBuffer, mimeType }],
        requireVision: true,
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
          const [yMin, xMin, yMax, xMax] = d.box_2d;
          return {
            x: xMin,
            y: yMin,
            width: xMax - xMin,
            height: yMax - yMin,
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
      throw new Error('Failed to get bounding boxes from AI service.');
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
    return { x, y, width: x2 - x, height: y2 - y };
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