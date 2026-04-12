/**
 * PoC test script for Florence-2 receipt detection.
 *
 * Usage:
 *   npx tsx scripts/test-florence2.ts <path-to-image>
 *
 * What it does:
 *   1. Loads Florence-2-base-ft (int8) — first run downloads ~250 MB
 *   2. Runs OPEN_VOCABULARY_DETECTION with prompt "receipt"
 *   3. Draws red bounding boxes on the input image
 *   4. Saves result to scripts/output/florence2-<filename>.png
 *   5. Logs RAM peak, inference time, raw output, parsed boxes
 */

import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import {
  AutoProcessor,
  AutoTokenizer,
  Florence2ForConditionalGeneration,
  RawImage,
} from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Florence-2-base-ft';
// CAPTION_TO_PHRASE_GROUNDING grounds words from a caption to bounding boxes.
// We give a caption like "A photo of receipts" and Florence-2 returns boxes for "receipts".
const TASK_PROMPT = '<CAPTION_TO_PHRASE_GROUNDING>';
const QUERY = 'A photo of receipts on a table.';

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function logMemory(label: string) {
  const m = process.memoryUsage();
  console.log(
    `[mem] ${label}: rss=${formatMB(m.rss)}, heap=${formatMB(m.heapUsed)}/${formatMB(m.heapTotal)}, ext=${formatMB(m.external)}`
  );
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: npx tsx scripts/test-florence2.ts <path-to-image>');
    process.exit(1);
  }

  const absPath = path.resolve(inputPath);
  console.log(`\n=== Florence-2 PoC ===`);
  console.log(`Input: ${absPath}`);
  console.log(`Model: ${MODEL_ID} (int8 quantized)`);
  console.log(`Task:  ${TASK_PROMPT}${QUERY}\n`);

  logMemory('startup');

  // -------- Load model --------
  console.log('Loading processor + tokenizer...');
  const tProc = Date.now();
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  console.log(`  processor + tokenizer loaded in ${Date.now() - tProc} ms`);

  console.log('Loading Florence-2 model (int8)...');
  const tModel = Date.now();
  const model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
    dtype: 'int8',
  });
  console.log(`  model loaded in ${Date.now() - tModel} ms`);
  logMemory('after model load');

  // -------- Prepare image --------
  console.log('\nReading image...');
  const imageBuffer = await fs.readFile(absPath);
  const meta = await sharp(imageBuffer).metadata();
  console.log(`  dimensions: ${meta.width}x${meta.height}, format: ${meta.format}`);

  // RawImage.read() expects a URL or Blob/ArrayBuffer-like; convert webp/jpeg to RGB PNG buffer first
  // for consistent decoding via transformers.js
  const pngBuffer = await sharp(imageBuffer).removeAlpha().toFormat('png').toBuffer();
  const blob = new Blob([new Uint8Array(pngBuffer)], { type: 'image/png' });
  const image = await RawImage.fromBlob(blob);
  console.log(`  RawImage: ${image.width}x${image.height}, channels: ${image.channels}`);

  // -------- Run inference --------
  console.log('\nRunning inference...');
  const tInfer = Date.now();

  // Florence-2 needs special prompt template construction.
  // processor.construct_prompts() expands task tokens like <OD> into the
  // full prompt format the model was trained on.
  const taskInput = `${TASK_PROMPT}${QUERY}`;
  const prompts = (processor as any).construct_prompts(taskInput);
  console.log(`  constructed prompt:`, prompts);

  const visionInputs = await processor(image);
  const textInputs = tokenizer(prompts);

  const generatedIds = await model.generate({
    ...textInputs,
    ...visionInputs,
    max_new_tokens: 1024,
    num_beams: 3,
    do_sample: false,
  });
  const inferMs = Date.now() - tInfer;
  console.log(`  inference done in ${inferMs} ms`);
  logMemory('after inference');

  // -------- Decode --------
  const generatedText = tokenizer.batch_decode(generatedIds as any, {
    skip_special_tokens: false,
  })[0];
  console.log(`\nRaw output:\n${generatedText}\n`);

  const result = processor.post_process_generation(
    generatedText,
    TASK_PROMPT,
    image.size as [number, number]
  );
  console.log('Parsed result:');
  console.log(JSON.stringify(result, null, 2));

  // -------- Draw overlay --------
  const taskKey = TASK_PROMPT.replace(/[<>]/g, '');
  const detection = (result as any)[taskKey] ?? (result as any)[TASK_PROMPT] ?? result;
  const bboxes: number[][] = detection?.bboxes ?? [];
  const labels: string[] = detection?.bboxes_labels ?? detection?.labels ?? [];

  console.log(`\nDetected ${bboxes.length} box(es).`);

  if (bboxes.length > 0) {
    const rects = bboxes
      .map((box, i) => {
        const [x1, y1, x2, y2] = box;
        const w = x2 - x1;
        const h = y2 - y1;
        const label = labels[i] || `#${i}`;
        return `<rect x="${x1}" y="${y1}" width="${w}" height="${h}" stroke="red" stroke-width="6" fill="none"/>
          <text x="${x1 + 5}" y="${y1 + 30}" fill="red" font-size="28" font-family="sans-serif">${label}</text>`;
      })
      .join('\n');

    const svg = `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;

    const outDir = path.resolve('scripts/output');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `florence2-${path.basename(absPath, path.extname(absPath))}.png`);

    await sharp(imageBuffer)
      .composite([{ input: Buffer.from(svg), blend: 'over' }])
      .toFormat('png')
      .toFile(outPath);

    console.log(`\nMarked image saved: ${outPath}`);
  } else {
    console.warn('\n⚠️  No bounding boxes detected.');
  }

  console.log(`\n=== Summary ===`);
  console.log(`Inference time:  ${inferMs} ms`);
  console.log(`Detected boxes:  ${bboxes.length}`);
  logMemory('final');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
