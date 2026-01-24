import sharp from 'sharp';
import { GoogleGenerativeAI, Part } from '@google/generative-ai'; // Import Gemini client

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SplitImageOptions {
  debug?: boolean;
}

interface SplitImageResult {
  images: Buffer[];
  debug?: {
    boundingBoxes: BoundingBox[];
    geminiResponse?: any; // To store raw Gemini response for debugging
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
          // We can add rawGeminiResponse here if needed for deeper debugging
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
        console.log(`\nBox ${i + 1} - Gemini coordinates (1000x1000 grid):`, box);
        
        // Convert 1000x1000 grid coordinates to actual pixel coordinates
        const pixelX = Math.round((box.x / 1000) * imageWidth);
        const pixelY = Math.round((box.y / 1000) * imageHeight);
        const pixelWidth = Math.round((box.width / 1000) * imageWidth);
        const pixelHeight = Math.round((box.height / 1000) * imageHeight);

        console.log(`Box ${i + 1} - Converted to pixels: x=${pixelX}, y=${pixelY}, width=${pixelWidth}, height=${pixelHeight}`);

        // Add 5% padding to each side as a safety margin to compensate for detection inaccuracies
        const paddingWidth = Math.round(pixelWidth * 0.05);
        const paddingHeight = Math.round(pixelHeight * 0.05);

        const paddedX = pixelX - paddingWidth;
        const paddedY = pixelY - paddingHeight;
        const paddedWidth = pixelWidth + (paddingWidth * 2);
        const paddedHeight = pixelHeight + (paddingHeight * 2);

        console.log(`Box ${i + 1} - After padding: x=${paddedX}, y=${paddedY}, width=${paddedWidth}, height=${paddedHeight}`);

        const left = Math.max(0, paddedX);
        const top = Math.max(0, paddedY);
        const width = paddedWidth;
        const height = paddedHeight;

        if (left >= imageWidth || top >= imageHeight) {
          console.warn('Skipping bounding box starting outside of image bounds (after conversion):', box);
          continue;
        }

        const extractWidth = Math.min(width, imageWidth - left);
        const extractHeight = Math.min(height, imageHeight - top);
        
        if (extractWidth <= 0 || extractHeight <= 0) {
            console.warn('Skipping bounding box with zero or negative dimensions after clamping (after conversion):', {box, extractWidth, extractHeight});
            continue;
        }

        const croppedImageBuffer = await sharp(imageBuffer)
          .extract({ left, top, width: extractWidth, height: extractHeight })
          .toBuffer();
        result.images.push(croppedImageBuffer);
      }

      return result;
    } catch (error) {
      console.error('Error in splitImage method. Original error:', error); // Log the original error
      throw new Error('Could not split the image using Gemini.');
    }
  }

  private async callGeminiForBoundingBoxes(imageBuffer: Buffer): Promise<BoundingBox[]> {
    const model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Encode image to base64
    const base64Image = imageBuffer.toString('base64');
    const imagePart: Part = {
      inlineData: {
        data: base64Image,
        mimeType: 'image/jpeg' // Assuming input is always JPEG, might need to infer from metadata
      },
    };

    const prompt = `
      You are an expert at identifying receipts in images.
      Analyze the provided image and identify all distinct receipts.
      For each distinct receipt found, provide its bounding box coordinates in the following JSON format:
      [
        {"x": int, "y": int, "width": int, "height": int},
        {"x": int, "y": int, "width": int, "height": int}
      ]
      
      IMPORTANT INSTRUCTIONS:
      - Coordinates (x, y, width, height) should be relative to a 1000x1000 grid where [0,0] is the top-left and [1000,1000] is the bottom-right
      - x is the LEFT edge of the receipt, y is the TOP edge
      - width is the FULL width of the receipt from left to right edge
      - height is the FULL height of the receipt from top to bottom edge
      - BE VERY GENEROUS with bounding boxes - include extra margin (at least 5% on all sides) to ensure NO part of any receipt is cut off
      - For receipts arranged horizontally (side by side), make sure each box captures the COMPLETE receipt including all text, barcodes, and edges
      - If receipts are side-by-side, ensure the boxes don't drift or become misaligned - each receipt should have accurate independent coordinates
      - Double-check that the rightmost receipts are fully captured, not cut off
      - Return ONLY the JSON array, no other text or explanation
    `;

    try {
      const result = await model.generateContent([prompt, imagePart]);
      let responseText = result.response.text();
      console.log('Gemini raw response:', responseText); // Log raw response for debugging

      // Clean the response: remove markdown code fences
      const jsonRegex = /```json\n([\s\S]*?)\n```/;
      const match = responseText.match(jsonRegex);
      if (match && match[1]) {
        responseText = match[1];
        console.log('Cleaned JSON response:', responseText);
      }

      // Attempt to parse the JSON response
      const boundingBoxes: BoundingBox[] = JSON.parse(responseText);

      // Basic validation of the parsed data
      if (!Array.isArray(boundingBoxes) || !boundingBoxes.every(box => 
          typeof box.x === 'number' && typeof box.y === 'number' &&
          typeof box.width === 'number' && typeof box.height === 'number'
      )) {
          throw new Error('Gemini response is not in the expected bounding box format.');
      }

      return boundingBoxes;
    } catch (error) {
      console.error('Error calling Gemini API for bounding boxes. Original error:', error); // Log the original error
      // If parsing fails or Gemini doesn't return JSON, it might return text.
      // We can try to log the response if it's not JSON
      if (error instanceof SyntaxError && error.message.includes('JSON.parse')) {
          console.error('Gemini did not return valid JSON. The raw response from Gemini will be logged above.');
      }
      throw new Error('Failed to get bounding boxes from Gemini.');
    }
  }
}