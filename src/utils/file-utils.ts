import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure the uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/**
 * Compresses an image to lossless WebP.
 * Normalizes EXIF orientation, strips all metadata, converts to 8-bit sRGB.
 * Lossless mode preserves pixel-perfect quality — important for OCR accuracy.
 * Does NOT use ImageMagick; uses libvips (via sharp) which is significantly faster.
 */
export async function compressToWebP(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer)
    .rotate()                   // normalize EXIF orientation
    .toColorspace('srgb')       // normalize to 8-bit sRGB, drops 16-bit/wide-gamut bloat
    .withMetadata({})           // strip EXIF, ICC profiles, GPS, thumbnails, etc.
    .webp({ lossless: true })
    .toBuffer();
}

/**
 * Returns the SHA-256 hex digest of a buffer, with an appended extension.
 * Used to generate deterministic, content-addressable filenames.
 */
export function hashFilename(buffer: Buffer, ext: string): string {
  return createHash('sha256').update(buffer).digest('hex') + ext;
}

/**
 * Saves a buffer to the uploads directory under the given filename.
 * The caller is responsible for passing a unique filename (e.g. via hashFilename).
 */
export async function saveFile(buffer: Buffer, filename: string): Promise<{ filePath: string; publicUrl: string }> {
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.promises.writeFile(filePath, buffer);
  return { filePath, publicUrl: `/files/${filename}` };
}

/**
 * Computes a 64-bit difference hash (dHash) of an image for near-duplicate detection.
 * Resizes to 9×8, converts to grayscale, then compares adjacent horizontal pixel pairs.
 * Returns a 16-char hex string. Images with Hamming distance ≤ 8 are near-duplicates.
 */
export async function computePerceptualHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 9 + col;
      if (data[idx] > data[idx + 1]) {
        hash |= 1n << BigInt(row * 8 + col);
      }
    }
  }
  return hash.toString(16).padStart(16, '0');
}

export function perceptualHashDistance(a: string, b: string): number {
  let xor = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
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
