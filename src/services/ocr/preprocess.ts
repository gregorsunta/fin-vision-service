import sharp from 'sharp';
import { getOsdWorker } from '../../utils/tesseract.js';
import { getConfig } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('services.ocr.preprocess');

/**
 * Detects and corrects 90°/180°/270° rotation using Tesseract OSD.
 * Returns the original image if OSD fails or confidence is below threshold.
 *
 * OSD only handles axis-aligned orientations (multiples of 90°). Fine-grained
 * tilt correction (< 45°) is handled in ImageSplitterService at crop time.
 */
export async function correctRotation(image: Buffer): Promise<Buffer> {
  const minConfidence = getConfig().OSD_MIN_CONFIDENCE;
  try {
    const worker = await getOsdWorker();
    // Grayscale + normalize improve OSD confidence and 180° detection.
    // PNG because Tesseract/Leptonica doesn't handle WebP reliably.
    const pngBuffer = await sharp(image).grayscale().normalize().png().toBuffer();
    const { data } = await worker.detect(pngBuffer);

    const degrees = data.orientation_degrees;
    const confidence = data.orientation_confidence ?? 0;

    if (degrees === null || degrees === 0 || confidence < minConfidence) {
      return image;
    }

    // `orientation_degrees` is the clockwise rotation already applied to the
    // image. Rotating by the negative restores upright orientation.
    const correction = (360 - degrees) % 360;
    log.info(
      { correction, originalDegrees: degrees, confidence: Number(confidence.toFixed(2)) },
      'OSD rotating image',
    );
    return await sharp(image).rotate(correction).toBuffer();
  } catch (error) {
    log.warn({ err: error }, 'OSD rotation detection failed, continuing with original orientation');
    return image;
  }
}

/**
 * Preprocesses an image for OCR: rotation correction + grayscale + contrast
 * normalization + sharpen. Controlled by the `OCR_PREPROCESS` env var
 * (defaults to enabled). Disable for A/B comparison or already-clean images.
 */
export async function preprocessForOcr(image: Buffer): Promise<Buffer> {
  if (!getConfig().OCR_PREPROCESS) {
    return image;
  }
  try {
    const oriented = await correctRotation(image);
    return await sharp(oriented)
      .rotate() // honor any remaining EXIF orientation
      .grayscale()
      .normalize()
      .sharpen()
      .toBuffer();
  } catch (error) {
    log.warn({ err: error }, 'OCR image preprocessing failed, falling back to raw image');
    return image;
  }
}
