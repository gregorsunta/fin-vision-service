import { describe, it, expect, vi } from 'vitest';
import {
  computeIoU,
  unionBox,
  coverageOf,
  mergeOverlappingBoxes,
  filterBoxes,
} from '../src/services/splitter/geometry.js';
import type { BoundingBox } from '../src/services/splitter/types.js';

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function box(x: number, y: number, w: number, h: number): BoundingBox {
  return { x, y, width: w, height: h };
}

// ─── computeIoU ───────────────────────────────────────────────────────────

describe('computeIoU', () => {
  it('returns 1.0 for identical boxes', () => {
    expect(computeIoU(box(0, 0, 100, 100), box(0, 0, 100, 100))).toBeCloseTo(1.0);
  });

  it('returns 0 for non-overlapping boxes', () => {
    expect(computeIoU(box(0, 0, 100, 100), box(200, 200, 100, 100))).toBe(0);
  });

  it('returns 0 for adjacent (touching) boxes', () => {
    expect(computeIoU(box(0, 0, 100, 100), box(100, 0, 100, 100))).toBe(0);
  });

  it('returns correct IoU for 50% overlap', () => {
    // Two 100×100 boxes, overlapping by 50×100 = 5000; union = 15000
    const iou = computeIoU(box(0, 0, 100, 100), box(50, 0, 100, 100));
    expect(iou).toBeCloseTo(5000 / 15000, 5);
  });

  it('returns correct IoU for partial overlap', () => {
    // box A: (0,0)→(200,200)  area=40000
    // box B: (100,100)→(300,300) area=40000
    // intersection: (100,100)→(200,200) area=10000
    // union: 70000
    const iou = computeIoU(box(0, 0, 200, 200), box(100, 100, 200, 200));
    expect(iou).toBeCloseTo(10000 / 70000, 5);
  });
});

// ─── unionBox ─────────────────────────────────────────────────────────────

describe('unionBox', () => {
  it('returns bounding box spanning both inputs', () => {
    const result = unionBox(box(0, 0, 100, 100), box(50, 50, 100, 100));
    expect(result).toMatchObject({ x: 0, y: 0, width: 150, height: 150 });
  });

  it('averages rotation', () => {
    const a = { ...box(0, 0, 100, 100), rotation: 10 };
    const b = { ...box(50, 50, 100, 100), rotation: 20 };
    expect(unionBox(a, b).rotation).toBe(15);
  });
});

// ─── coverageOf ───────────────────────────────────────────────────────────

describe('coverageOf', () => {
  it('returns 1.0 when B is fully inside A', () => {
    expect(coverageOf(box(10, 10, 50, 50), box(0, 0, 100, 100))).toBeCloseTo(1.0);
  });

  it('returns 0 when boxes do not overlap', () => {
    expect(coverageOf(box(0, 0, 100, 100), box(200, 200, 100, 100))).toBe(0);
  });

  it('returns 0.25 when B is 25% covered by A', () => {
    // B: (0,0)→(200,200) area=40000; A: (0,0)→(100,100); intersection=10000
    expect(coverageOf(box(0, 0, 200, 200), box(0, 0, 100, 100))).toBeCloseTo(0.25);
  });
});

// ─── mergeOverlappingBoxes ────────────────────────────────────────────────

describe('mergeOverlappingBoxes', () => {
  it('returns single box unchanged', () => {
    const boxes = [box(0, 0, 100, 100)];
    expect(mergeOverlappingBoxes(boxes)).toEqual(boxes);
  });

  it('merges two heavily overlapping boxes', () => {
    // IoU = 1.0 → should merge
    const result = mergeOverlappingBoxes([box(0, 0, 100, 100), box(0, 0, 100, 100)]);
    expect(result).toHaveLength(1);
  });

  it('keeps two non-overlapping boxes separate', () => {
    const result = mergeOverlappingBoxes([box(0, 0, 100, 100), box(500, 500, 100, 100)]);
    expect(result).toHaveLength(2);
  });

  it('merges boxes with IoU just above threshold (0.3)', () => {
    // Construct boxes with IoU ≈ 0.5 to be clearly above threshold
    const result = mergeOverlappingBoxes(
      [box(0, 0, 200, 200), box(100, 0, 200, 200)],
      0.3,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('does not merge boxes with IoU below threshold', () => {
    // minimal overlap — IoU well below 0.3
    const result = mergeOverlappingBoxes(
      [box(0, 0, 100, 100), box(95, 95, 100, 100)],
      0.3,
    );
    expect(result).toHaveLength(2);
  });
});

// ─── filterBoxes ──────────────────────────────────────────────────────────

describe('filterBoxes', () => {
  it('returns single box unchanged', () => {
    const b = [box(0, 0, 500, 500)];
    expect(filterBoxes(b)).toEqual(b);
  });

  it('removes tiny boxes (area < 10000 in 0-1000 space)', () => {
    const tiny = box(0, 0, 50, 50);   // area=2500 < 10000
    const large = box(0, 0, 400, 400); // area=160000
    const result = filterBoxes([tiny, large]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(large);
  });

  it('removes container box when it encompasses 2+ others', () => {
    // container covers A and B each by > 60%
    const container = box(0, 0, 1000, 1000);
    const a = box(10, 10, 300, 400);
    const b = box(500, 10, 300, 400);
    const result = filterBoxes([container, a, b]);
    expect(result).not.toContainEqual(container);
    expect(result).toContainEqual(a);
    expect(result).toContainEqual(b);
  });

  it('removes sub-region box that is largely inside a bigger box', () => {
    // large box; small is 80%+ covered by large AND < 70% of large's area
    const large = box(0, 0, 500, 500);   // area=250000
    const small = box(50, 50, 200, 200); // area=40000 < 70%*250000=175000; coverage ≈ 100%
    const result = filterBoxes([large, small]);
    expect(result).toContainEqual(large);
    expect(result).not.toContainEqual(small);
  });

  it('keeps two non-overlapping same-size boxes', () => {
    const a = box(0, 0, 400, 600);
    const b = box(500, 0, 400, 600);
    expect(filterBoxes([a, b])).toHaveLength(2);
  });
});
