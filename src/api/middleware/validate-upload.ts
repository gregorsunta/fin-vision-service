import sharp from 'sharp';

const MAX_WIDTH = 8000;
const MAX_HEIGHT = 8000;
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB hard cap (multipart enforces 10 MB, but this guards re-use)

// Magic-byte signatures for allowed image formats
const SIGNATURES: Array<{ label: string; check: (b: Buffer) => boolean }> = [
  {
    label: 'JPEG',
    check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    label: 'PNG',
    check: (b) =>
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    label: 'WEBP',
    // RIFF....WEBP
    check: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

export class UploadValidationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'UploadValidationError';
    this.statusCode = statusCode;
  }
}

/**
 * Validates an image buffer before processing. Throws `UploadValidationError`
 * on any violation so the upload route can return a clean 400 to the client.
 *
 * Checks (in order):
 *  1. File size — catches any bypass of the multipart limit
 *  2. Magic bytes — rejects disguised files (e.g. a .txt renamed to .jpg)
 *  3. Image dimensions — prevents OOM in sharp / Vision API on huge canvases
 */
export async function validateImageBuffer(buffer: Buffer): Promise<void> {
  if (buffer.byteLength > MAX_BYTES) {
    throw new UploadValidationError(
      `File exceeds the maximum allowed size of ${MAX_BYTES / 1024 / 1024} MB.`,
    );
  }

  const matched = SIGNATURES.some((sig) => sig.check(buffer));
  if (!matched) {
    throw new UploadValidationError(
      'Unsupported file format. Please upload a JPEG, PNG, or WEBP image.',
    );
  }

  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(buffer).metadata());
  } catch {
    throw new UploadValidationError('Could not read image metadata. The file may be corrupt.');
  }

  if (!width || !height) {
    throw new UploadValidationError('Could not determine image dimensions.');
  }

  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new UploadValidationError(
      `Image dimensions (${width}×${height}) exceed the maximum allowed size of ${MAX_WIDTH}×${MAX_HEIGHT} pixels.`,
    );
  }
}
