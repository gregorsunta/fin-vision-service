import sharp from 'sharp';
import { GoogleGenerativeAI, Part } from '@google/generative-ai';

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

interface SplitImageOptions {
  debug?: boolean;
}

interface SplitImageResult {
  images: Buffer[];
  debug?: {
    boundingBoxes: BoundingBox[];
    geminiResponse?: any;
  };
}

export class ImageSplitterService {
  private genAI: GoogleGenerativeAI;
  private readonly GEMINI_API_KEY: string;

  constructor() {
    this.GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
    if (!this.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set in the environment variables');
    }
    this.genAI = new GoogleGenerativeAI(this.GEMINI_API_KEY);
  }

  public async splitImage(imageBuffer: Buffer, options: SplitImageOptions = {}): Promise<SplitImageResult> {
    const { debug = false } = options;

    try {
      const detectedBoundingBoxes = await this.callGeminiForBoundingBoxes(imageBuffer);

      const result: SplitImageResult = {
        images: [],
      };

      if (debug) {
        result.debug = {
          boundingBoxes: detectedBoundingBoxes,
        };
      }

      if (detectedBoundingBoxes.length === 0) {
        console.warn('Gemini did not detect any distinct receipts. Returning the original image.');
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

  private async callGeminiForBoundingBoxes(imageBuffer: Buffer): Promise<BoundingBox[]> {
    const model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const base64Image = imageBuffer.toString('base64');
    const mimeType = await this.detectMimeType(imageBuffer);
    const imagePart: Part = {
      inlineData: {
        data: base64Image,
        mimeType,
      },
    };

    const prompt = `Detect all individual receipts in this image. Return bounding boxes as a JSON array with labels. Never return masks or code fencing. If there are multiple receipts, detect each one separately.`;

    try {
      const result = await model.generateContent([prompt, imagePart]);
      let responseText = result.response.text();
      console.log('Gemini raw response:', responseText);

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
      const boundingBoxes: BoundingBox[] = detections
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

      console.log(`Detected ${boundingBoxes.length} receipt(s) from Gemini response`);
      return boundingBoxes;
    } catch (error) {
      console.error('Error calling Gemini API for bounding boxes. Original error:', error);
      if (error instanceof SyntaxError && error.message.includes('JSON.parse')) {
        console.error('Gemini did not return valid JSON. The raw response is logged above.');
      }
      throw new Error('Failed to get bounding boxes from Gemini.');
    }
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