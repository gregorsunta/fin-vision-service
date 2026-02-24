import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure the uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/**
 * Detects content orientation using Tesseract OSD and rotates the image to upright.
 * Handles cases where EXIF data is absent or unreliable (e.g. phone held flat over a surface).
 * Falls back gracefully without rotation if detection fails (too little text, blank image, etc.).
 */
export async function correctOrientation(imageBuffer: Buffer): Promise<Buffer> {
  const worker = await createWorker('osd');
  try {
    const { data } = await worker.detect(imageBuffer);
    const angle = (data as any).orientation_degrees ?? 0;
    if (angle === 0) return imageBuffer;
    console.log(`Content orientation detected: ${angle}°, rotating image.`);
    return await sharp(imageBuffer).rotate(angle).toBuffer();
  } catch {
    console.warn('Orientation detection skipped (insufficient text or detection error).');
    return imageBuffer;
  } finally {
    await worker.terminate();
  }
}

/**
 * Compresses an image to WebP format with EXIF orientation normalization.
 */
export async function compressToWebP(imageBuffer: Buffer, quality = 80): Promise<Buffer> {
  return sharp(imageBuffer)
    .rotate() // normalize EXIF orientation
    .webp({ quality })
    .toBuffer();
}

/**
 * Saves a buffer to a unique file in the uploads directory.
 * @param buffer The file content.
 * @param originalFilename The original name of the file to preserve the extension.
 * @returns A promise that resolves to the absolute file path and the public-facing URL.
 */
export async function saveFile(buffer: Buffer, originalFilename: string): Promise<{ filePath: string, publicUrl: string }> {
  const uniqueSuffix = randomBytes(16).toString('hex');
  const extension = path.extname(originalFilename) || '.jpg';
  const uniqueFilename = `${uniqueSuffix}${extension}`;
  const filePath = path.join(UPLOADS_DIR, uniqueFilename);
  await fs.promises.writeFile(filePath, buffer);
  const publicUrl = `/files/${uniqueFilename}`;
  return { filePath, publicUrl };
}

/**
 * Deletes a file from the uploads directory given its public URL.
 */
export async function deleteFile(publicUrl: string): Promise<void> {
  const filename = path.basename(publicUrl);
  const filePath = path.join(UPLOADS_DIR, filename);
  try {
    await fs.promises.unlink(filePath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}
