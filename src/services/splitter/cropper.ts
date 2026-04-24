import sharp from 'sharp';
import { createLogger } from '../../utils/logger.js';
import type { BoundingBox } from './types.js';

const log = createLogger('services.splitter.cropper');

/**
 * Crops each bounding box out of the source image. Boxes use normalized
 * 0–1000 coordinates; conversion to pixels happens here. A padding factor is
 * added around each crop (15% for tilted boxes, 5% otherwise) to avoid clipping
 * receipt edges after tilt correction. Boxes outside image bounds or with
 * non-positive dimensions after clamping are skipped.
 */
export async function cropBoxes(imageBuffer: Buffer, boxes: BoundingBox[]): Promise<Buffer[]> {
  const { width: imageWidth, height: imageHeight } = await sharp(imageBuffer).metadata();
  if (!imageWidth || !imageHeight) {
    throw new Error('Could not get image dimensions');
  }

  log.debug({ imageWidth, imageHeight, boxCount: boxes.length }, 'cropping boxes');

  const crops: Buffer[] = [];

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const rotation = box.rotation ?? 0;
    log.debug({ boxIndex: i + 1, box }, 'box normalized coordinates');

    const pixelX = Math.round((box.x / 1000) * imageWidth);
    const pixelY = Math.round((box.y / 1000) * imageHeight);
    const pixelWidth = Math.round((box.width / 1000) * imageWidth);
    const pixelHeight = Math.round((box.height / 1000) * imageHeight);

    log.debug({ boxIndex: i + 1, pixelX, pixelY, pixelWidth, pixelHeight }, 'box pixel coordinates');

    const paddingFactor = Math.abs(rotation) > 5 ? 0.15 : 0.05;
    const paddingWidth = Math.round(pixelWidth * paddingFactor);
    const paddingHeight = Math.round(pixelHeight * paddingFactor);

    const left = Math.max(0, pixelX - paddingWidth);
    const top = Math.max(0, pixelY - paddingHeight);
    const width = pixelWidth + paddingWidth * 2;
    const height = pixelHeight + paddingHeight * 2;

    if (left >= imageWidth || top >= imageHeight) {
      log.warn({ box }, 'skipping bounding box outside image bounds');
      continue;
    }

    const extractWidth = Math.min(width, imageWidth - left);
    const extractHeight = Math.min(height, imageHeight - top);

    if (extractWidth <= 0 || extractHeight <= 0) {
      log.warn(
        { box, extractWidth, extractHeight },
        'skipping bounding box with zero/negative dimensions after clamping',
      );
      continue;
    }

    log.debug({ boxIndex: i + 1, left, top, extractWidth, extractHeight }, 'extracting box');

    let cropped = await sharp(imageBuffer)
      .extract({ left, top, width: extractWidth, height: extractHeight })
      .toBuffer();

    if (Math.abs(rotation) > 2) {
      log.debug({ boxIndex: i + 1, rotation }, 'correcting tilt');
      cropped = await sharp(cropped)
        .rotate(-rotation, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .toBuffer();
    }

    crops.push(cropped);
  }

  return crops;
}
