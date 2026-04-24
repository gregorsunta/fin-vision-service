import { createLogger } from '../../utils/logger.js';
import type { BoundingBox } from './types.js';

const log = createLogger('services.splitter.geometry');

/**
 * Intersection-over-Union for axis-aligned boxes in any consistent coordinate space.
 */
export function computeIoU(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection === 0) return 0;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;
  return intersection / union;
}

/** Smallest axis-aligned rectangle containing both boxes; rotation averaged. */
export function unionBox(a: BoundingBox, b: BoundingBox): BoundingBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  const rotation = ((a.rotation ?? 0) + (b.rotation ?? 0)) / 2;
  return { x, y, width: x2 - x, height: y2 - y, rotation };
}

/** Fraction of box B's area that is covered by box A. 1.0 = B fully inside A. */
export function coverageOf(b: BoundingBox, a: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaB = b.width * b.height;
  return areaB > 0 ? intersection / areaB : 0;
}

/**
 * Merges bounding boxes that overlap significantly (IoU > threshold),
 * preventing duplicate crops of the same receipt.
 */
export function mergeOverlappingBoxes(boxes: BoundingBox[], iouThreshold = 0.3): BoundingBox[] {
  if (boxes.length <= 1) return boxes;

  const merged = new Array<boolean>(boxes.length).fill(false);
  const result: BoundingBox[] = [];

  for (let i = 0; i < boxes.length; i++) {
    if (merged[i]) continue;
    let current = boxes[i];

    for (let j = i + 1; j < boxes.length; j++) {
      if (merged[j]) continue;
      const iou = computeIoU(current, boxes[j]);
      if (iou > iouThreshold) {
        log.debug({ i, j, iou: Number(iou.toFixed(2)) }, 'boxes overlap, merging');
        current = unionBox(current, boxes[j]);
        merged[j] = true;
      }
    }

    result.push(current);
  }

  return result;
}

/**
 * Removes three classes of implausible bounding boxes (all coordinates are in
 * the 0–1000 normalized space):
 *
 * 1. Too small — boxes covering less than 1% of the image area (≤ 10 000 units²)
 *    are almost certainly noise or tiny scraps, not full receipts.
 *
 * 2. Container boxes — a box that "contains" two or more other boxes (≥ 60 % of
 *    each smaller box's area lies inside it) is the region encompassing all the
 *    receipts, not a receipt itself. Discard it; keep the individual receipts.
 *
 * 3. Sub-region boxes — a box B where ≥ 80 % of its own area lies inside a
 *    larger box A, AND B is smaller than 70 % of A's area, is a partial
 *    re-detection of the same receipt. Keep A, discard B.
 */
export function filterBoxes(boxes: BoundingBox[]): BoundingBox[] {
  if (boxes.length <= 1) return boxes;

  const MIN_AREA = 10_000; // 1 % of 1000×1000 normalized space
  let candidates = boxes.filter((box) => {
    const area = box.width * box.height;
    if (area < MIN_AREA) {
      log.debug({ area }, 'dropping tiny box, likely not a receipt');
      return false;
    }
    return true;
  });

  if (candidates.length <= 1) return candidates;

  const isContainer = new Array<boolean>(candidates.length).fill(false);
  for (let i = 0; i < candidates.length; i++) {
    let containedCount = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      if (coverageOf(candidates[j], candidates[i]) >= 0.60) {
        containedCount++;
      }
    }
    if (containedCount >= 2) {
      log.debug({ boxIndex: i, containedCount }, 'box is a container, discarding');
      isContainer[i] = true;
    }
  }
  candidates = candidates.filter((_, idx) => !isContainer[idx]);

  if (candidates.length <= 1) return candidates;

  const isSubRegion = new Array<boolean>(candidates.length).fill(false);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j || isSubRegion[i]) continue;
      const areaI = candidates[i].width * candidates[i].height;
      const areaJ = candidates[j].width * candidates[j].height;
      if (areaI >= areaJ) continue;
      if (
        coverageOf(candidates[i], candidates[j]) >= 0.80 &&
        areaI < areaJ * 0.70
      ) {
        log.debug(
          { i, j, coverage: Number(coverageOf(candidates[i], candidates[j]).toFixed(2)) },
          'box is a sub-region of another, discarding',
        );
        isSubRegion[i] = true;
      }
    }
  }
  return candidates.filter((_, idx) => !isSubRegion[idx]);
}
