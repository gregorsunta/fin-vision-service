export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface DetectionResult {
  rawResponse: string;
  rawBoundingBoxes: BoundingBox[];
  mergedBoundingBoxes: BoundingBox[];
  provider: string;
  model: string;
}

export interface SplitImageResult {
  images: Buffer[];
  splitMetadata?: {
    rawResponse: string;
    rawBoundingBoxes: BoundingBox[];
    mergedBoundingBoxes: BoundingBox[];
    provider: string;
    model: string;
    detectedCount: number;
    mergedCount: number;
  };
}
