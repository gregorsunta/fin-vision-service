import { AIService, getAIService } from '../ai/index.js';
import { detectReceiptsCV, isCvDetectorHealthy } from './cv-detector.js';
import { detectBoundingBoxesGemini } from './splitter/gemini-detector.js';
import { filterBoxes } from './splitter/geometry.js';
import { cropBoxes } from './splitter/cropper.js';
import { createLogger } from '../utils/logger.js';
import type { DetectionResult, SplitImageResult } from './splitter/types.js';

export type { BoundingBox, DetectionResult, SplitImageResult } from './splitter/types.js';

const log = createLogger('services.image-splitter');

/**
 * Thin orchestrator that (1) runs detection via CV sidecar with Gemini
 * fallback, (2) filters implausible boxes, (3) delegates cropping.
 * The heavy lifting lives in ./splitter/* modules.
 */
export class ImageSplitterService {
  private aiService: AIService;

  constructor(aiService?: AIService) {
    this.aiService = aiService || getAIService();
  }

  public async splitImage(imageBuffer: Buffer): Promise<SplitImageResult> {
    try {
      // Image is already EXIF-normalized by compressToWebP() at upload time.
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

      const detectedBoxes = detection.mergedBoundingBoxes;

      if (detectedBoxes.length === 0) {
        log.warn('AI did not detect any distinct receipts, returning the original image');
        result.images.push(imageBuffer);
        return result;
      }

      const filteredBoxes = filterBoxes(detectedBoxes);
      if (filteredBoxes.length === 0) {
        log.warn('all boxes filtered out, returning original image');
        result.images.push(imageBuffer);
        return result;
      }
      if (filteredBoxes.length < detectedBoxes.length) {
        log.info(
          { dropped: detectedBoxes.length - filteredBoxes.length, remaining: filteredBoxes.length },
          'filtered implausible boxes',
        );
      }

      const crops = await cropBoxes(imageBuffer, filteredBoxes);
      result.images.push(...crops);
      return result;
    } catch (error) {
      log.error({ err: error }, 'error in splitImage method');
      throw new Error('Could not split the image using Gemini.', { cause: error });
    }
  }

  /**
   * Tries the OpenCV sidecar first. Falls back to Gemini on: unhealthy sidecar,
   * zero detections, or any thrown error.
   */
  private async detectBoundingBoxesWithFallback(imageBuffer: Buffer): Promise<DetectionResult> {
    const cvHealthy = await isCvDetectorHealthy();
    if (cvHealthy) {
      try {
        const cvResult = await detectReceiptsCV(imageBuffer);
        if (cvResult.boundingBoxes.length > 0) {
          log.info(
            { boxCount: cvResult.boundingBoxes.length, meanConfidence: Number(cvResult.meanConfidence.toFixed(2)) },
            'CV detector returned boxes',
          );
          return {
            rawResponse: JSON.stringify(cvResult.debug ?? {}),
            rawBoundingBoxes: cvResult.boundingBoxes,
            mergedBoundingBoxes: cvResult.boundingBoxes,
            provider: 'opencv',
            model: 'opencv-canny-contours',
          };
        }
        log.warn('CV detector returned 0 boxes, falling back to Gemini');
      } catch (err) {
        log.warn({ err }, 'CV detector failed, falling back to Gemini');
      }
    } else {
      log.warn('CV sidecar unhealthy, using Gemini directly');
    }

    return detectBoundingBoxesGemini(imageBuffer, this.aiService);
  }
}
