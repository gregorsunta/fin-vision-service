/**
 * Resolves a (possibly partial) image path to something `fs.readFile` can use.
 *
 * The path can arrive in three shapes depending on the caller:
 *   1. absolute (`/Users/.../uploads/file.jpg`) — initial upload
 *   2. relative with prefix (`uploads/file.jpg`) — reprocess
 *   3. bare filename (`file.jpg`) — shouldn't happen, but handled defensively
 *
 * TODO(faza 4): replace with a single UPLOAD_ROOT-based resolver from config.
 */
export function resolveImagePath(imagePath: string): string {
  if (imagePath.startsWith('/')) return imagePath;
  if (imagePath.startsWith('uploads/')) return imagePath;
  return `uploads/${imagePath}`;
}
