import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { receiptUploads } from '../../db/schema.js';
import { compressToWebP, hashFilename, saveFile } from '../../utils/file-utils.js';
import type { BoundingBox, SplitImageResult } from '../../services/image-splitter.js';

/**
 * Builds an SVG overlay with red rectangles around each detected receipt,
 * composites it onto the original image, compresses, saves and returns
 * the public URL. Used for the "review your detections" UI.
 */
async function renderMarkedImage(sourceBuffer: Buffer, boxes: BoundingBox[]): Promise<Buffer> {
  const { width, height } = await sharp(sourceBuffer).metadata();
  if (!width || !height) return sourceBuffer;

  const rects = boxes.map((box) => {
    const left = Math.round((box.x / 1000) * width);
    const top = Math.round((box.y / 1000) * height);
    const rectWidth = Math.round((box.width / 1000) * width);
    const rectHeight = Math.round((box.height / 1000) * height);
    return `<rect x="${left}" y="${top}" width="${rectWidth}" height="${rectHeight}" stroke="red" stroke-width="5" fill="none"/>`;
  });

  const svgOverlay = `<svg width="${width}" height="${height}">${rects.join('')}</svg>`;
  const composed = await sharp(sourceBuffer)
    .composite([{ input: Buffer.from(svgOverlay), blend: 'over' }])
    .toBuffer();
  return Buffer.from(composed);
}

/**
 * Persists a marked-image + splitMetadata for the given upload. Falls back to
 * saving the original image (without overlay) when no merged boxes exist.
 */
export async function persistMarkedImage(
  uploadId: number,
  sourceBuffer: Buffer,
  splitResult: SplitImageResult,
): Promise<void> {
  const mergedBoxes = splitResult.splitMetadata?.mergedBoundingBoxes;
  const markedBuffer = mergedBoxes && mergedBoxes.length > 0
    ? await renderMarkedImage(sourceBuffer, mergedBoxes)
    : sourceBuffer;

  const compressed = await compressToWebP(markedBuffer);
  const { publicUrl: markedImageUrl } = await saveFile(compressed, hashFilename(compressed, '.webp'));

  await db
    .update(receiptUploads)
    .set({ markedImageUrl, splitMetadata: splitResult.splitMetadata ?? null })
    .where(eq(receiptUploads.id, uploadId));
}
