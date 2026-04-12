/**
 * Tests the OpenCV CV detector sidecar end-to-end.
 *
 * Prereqs:
 *   docker compose up -d cv-detector
 *
 * Usage:
 *   npx tsx scripts/test-cv-detector.ts <path-to-image>
 *
 * Outputs an annotated PNG to scripts/output/cv-<filename>.png
 */

import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { detectReceiptsCV, isCvDetectorHealthy } from '../src/services/cv-detector.js';

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: npx tsx scripts/test-cv-detector.ts <path-to-image>');
    process.exit(1);
  }

  const absPath = path.resolve(inputPath);
  console.log(`\n=== CV detector sidecar test ===`);
  console.log(`Input: ${absPath}\n`);

  if (!(await isCvDetectorHealthy())) {
    console.error('CV detector sidecar is not reachable.');
    console.error('Run: docker compose up -d cv-detector');
    process.exit(1);
  }

  const imageBuffer = await fs.readFile(absPath);

  const tStart = Date.now();
  const result = await detectReceiptsCV(imageBuffer);
  const elapsed = Date.now() - tStart;

  console.log(`Image:        ${result.imageWidth}x${result.imageHeight}`);
  console.log(`Boxes:        ${result.boundingBoxes.length}`);
  console.log(`Mean conf:    ${result.meanConfidence.toFixed(2)}`);
  console.log(`Latency:      ${elapsed} ms (includes HTTP)`);
  console.log(`\nDebug:`, JSON.stringify(result.debug, null, 2));

  console.log(`\nBounding boxes (normalized 0-1000):`);
  for (const box of result.boundingBoxes) {
    console.log(`  x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}, rot=${box.rotation?.toFixed(1)}°`);
  }

  if (result.boundingBoxes.length > 0) {
    const rects = result.boundingBoxes
      .map((box, i) => {
        const left = Math.round((box.x / 1000) * result.imageWidth);
        const top = Math.round((box.y / 1000) * result.imageHeight);
        const w = Math.round((box.width / 1000) * result.imageWidth);
        const h = Math.round((box.height / 1000) * result.imageHeight);
        return `<rect x="${left}" y="${top}" width="${w}" height="${h}" stroke="lime" stroke-width="8" fill="none"/>
          <text x="${left + 10}" y="${top + 50}" fill="lime" font-size="40" font-weight="bold" font-family="sans-serif">#${i + 1}</text>`;
      })
      .join('\n');

    const svg = `<svg width="${result.imageWidth}" height="${result.imageHeight}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;

    const outDir = path.resolve('scripts/output');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `cv-${path.basename(absPath, path.extname(absPath))}.png`);

    await sharp(imageBuffer)
      .composite([{ input: Buffer.from(svg), blend: 'over' }])
      .toFormat('png')
      .toFile(outPath);

    console.log(`\nMarked image saved: ${outPath}`);
  } else {
    console.warn('\nNo receipts detected.');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
