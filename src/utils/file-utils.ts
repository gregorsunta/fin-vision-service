import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure the uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
