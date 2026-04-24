import sharp from 'sharp';
import { getOsdWorker } from '../../utils/tesseract.js';
import { getConfig } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('worker.stages.orientation');

/**
 * Detects text orientation via Tesseract OSD and rotates the image to upright.
 * Called BEFORE saving, so the saved file and the OCR input are both correctly
 * oriented. Low-confidence detections fall through and return the original.
 */
export async function correctOrientationOSD(image: Buffer, boxIndex: number): Promise<Buffer> {
  const minConfidence = getConfig().OSD_MIN_CONFIDENCE;
  try {
    const worker = await getOsdWorker();
    // Grayscale + normalize improve OSD confidence and 180° detection.
    // PNG conversion because Tesseract/Leptonica doesn't handle WebP reliably.
    const pngBuffer = await sharp(image).grayscale().normalize().png().toBuffer();
    const { data } = await worker.detect(pngBuffer);

    const degrees = data.orientation_degrees;
    const confidence = data.orientation_confidence ?? 0;

    log.debug({ boxIndex, degrees, confidence: Number(confidence.toFixed(2)) }, 'OSD orientation detected');

    if (degrees === null || degrees === 0 || confidence < minConfidence) {
      return image;
    }

    const correction = (360 - degrees) % 360;
    log.info({ boxIndex, correction, originalDegrees: degrees }, 'OSD rotating image');
    return await sharp(image).rotate(correction).toBuffer();
  } catch (err) {
    log.warn({ err, boxIndex }, 'OSD orientation detection failed, keeping original');
    return image;
  }
}
