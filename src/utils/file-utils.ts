import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure the uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/**
 * Converts an image to near-lossless WebP (TinyPNG-style perceptual quantization).
 * Strips all metadata, normalizes to 8-bit sRGB, then applies near-lossless WebP encoding:
 * pixel values are rounded before lossless encoding — visually identical to the original
 * but significantly smaller than true lossless. Quality 80 is a good balance for receipts.
 */
export async function compressToWebP(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer)
    .rotate()                        // normalize EXIF orientation
    .toColorspace('srgb')            // normalize to 8-bit sRGB, drops 16-bit/wide-gamut bloat
    .withMetadata({})                // strip EXIF, ICC profiles, GPS, thumbnails, etc.
    .webp({ nearLossless: true, quality: 80 })
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
