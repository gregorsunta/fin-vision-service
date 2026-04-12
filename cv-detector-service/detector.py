"""
Grounding DINO Tiny receipt detector.

Uses HuggingFace transformers + PyTorch CPU to run zero-shot open-vocabulary
object detection. Model: IDEA-Research/grounding-dino-tiny (~172M parameters).

The model is loaded ONCE at module import time so the FastAPI worker keeps
the weights in memory across requests. Cold start is ~10-15 s; subsequent
inference is ~5-15 s on a single CPU core.
"""

import io
import os
from dataclasses import dataclass
from typing import List

import torch
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

MODEL_ID = os.environ.get("GROUNDING_MODEL", "IDEA-Research/grounding-dino-tiny")

# Grounding DINO expects each detection target as a lowercase phrase ending in
# a period. Multiple targets can be joined with periods.
TEXT_QUERY = "a receipt."

# Detection thresholds (tunable via env vars). Lower = more detections but
# more false positives.
BOX_THRESHOLD = float(os.environ.get("GD_BOX_THRESHOLD", "0.20"))
TEXT_THRESHOLD = float(os.environ.get("GD_TEXT_THRESHOLD", "0.20"))

# Reject any single detection that covers more than this fraction of the
# image — almost always a "the whole scene" catch-all rather than a receipt.
MAX_BOX_AREA_FRACTION = float(os.environ.get("GD_MAX_AREA_FRACTION", "0.70"))

# IoU threshold for non-max suppression. Lower = more aggressive deduplication.
NMS_IOU_THRESHOLD = float(os.environ.get("GD_NMS_IOU", "0.30"))


@dataclass
class BoundingBox:
    x: int                  # normalized 0-1000
    y: int
    width: int
    height: int
    rotation: float         # always 0 — Grounding DINO returns axis-aligned boxes
    confidence: float       # 0-1, model score


@dataclass
class DetectionResult:
    boxes: List[BoundingBox]
    image_width: int
    image_height: int
    debug: dict


class ReceiptDetector:
    def __init__(self) -> None:
        print(f"[detector] Loading {MODEL_ID}...")
        self.processor = AutoProcessor.from_pretrained(MODEL_ID)
        self.model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL_ID)
        self.model.eval()

        # Use a single CPU thread to keep RAM low and avoid contention with
        # the rest of the host. Inference latency is dominated by FLOPs anyway.
        torch.set_num_threads(int(os.environ.get("TORCH_NUM_THREADS", "2")))

        print(
            f"[detector] Loaded. params={sum(p.numel() for p in self.model.parameters()) / 1e6:.0f}M, "
            f"box_thr={BOX_THRESHOLD}, text_thr={TEXT_THRESHOLD}"
        )

    @torch.inference_mode()
    def detect(self, image_bytes: bytes) -> DetectionResult:
        try:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except Exception as e:
            raise ValueError(f"Could not decode image: {e}")

        orig_w, orig_h = image.size

        inputs = self.processor(images=image, text=TEXT_QUERY, return_tensors="pt")
        outputs = self.model(**inputs)

        # post_process_grounded_object_detection wants target_sizes as (h, w)
        results = self.processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            box_threshold=BOX_THRESHOLD,
            text_threshold=TEXT_THRESHOLD,
            target_sizes=[(orig_h, orig_w)],
        )[0]

        boxes_tensor = results["boxes"]   # absolute pixel coords (x1, y1, x2, y2)
        scores_tensor = results["scores"]
        labels = results.get("labels", [])

        image_area = float(orig_w * orig_h)
        boxes: List[BoundingBox] = []
        rejected_too_large = 0
        for box, score in zip(boxes_tensor.tolist(), scores_tensor.tolist()):
            x1, y1, x2, y2 = box
            x1 = max(0.0, x1)
            y1 = max(0.0, y1)
            x2 = min(float(orig_w), x2)
            y2 = min(float(orig_h), y2)
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue

            # Reject the catch-all "everything in the scene" detection that
            # Grounding DINO sometimes returns alongside the individual ones.
            box_area = (x2 - x1) * (y2 - y1)
            if box_area / image_area > MAX_BOX_AREA_FRACTION:
                rejected_too_large += 1
                continue

            boxes.append(
                BoundingBox(
                    x=int(round((x1 / orig_w) * 1000)),
                    y=int(round((y1 / orig_h) * 1000)),
                    width=int(round(((x2 - x1) / orig_w) * 1000)),
                    height=int(round(((y2 - y1) / orig_h) * 1000)),
                    rotation=0.0,
                    confidence=float(score),
                )
            )

        # NMS: Grounding DINO often returns multiple overlapping detections
        # for the same receipt. Drop any box whose IoU with a higher-scoring
        # earlier box exceeds NMS_IOU_THRESHOLD.
        boxes.sort(key=lambda b: b.confidence, reverse=True)
        deduped: List[BoundingBox] = []
        for b in boxes:
            if all(self._iou(b, k) <= NMS_IOU_THRESHOLD for k in deduped):
                deduped.append(b)

        # Majority-orientation filter: when most detected boxes are landscape
        # (or most are portrait), drop the ones that go against the trend.
        # These off-axis detections are usually false positives — slivers of
        # background or shadow that the model momentarily classified as a
        # receipt. We only apply this filter when there are enough boxes for
        # the majority signal to be meaningful (≥3).
        dropped_off_axis = 0
        if len(deduped) >= 3:
            landscape = sum(1 for b in deduped if b.width >= b.height)
            portrait = len(deduped) - landscape
            if landscape >= 2 * portrait:
                kept_after_filter = [b for b in deduped if b.width >= b.height]
                dropped_off_axis = len(deduped) - len(kept_after_filter)
                deduped = kept_after_filter
            elif portrait >= 2 * landscape:
                kept_after_filter = [b for b in deduped if b.height > b.width]
                dropped_off_axis = len(deduped) - len(kept_after_filter)
                deduped = kept_after_filter

        # Sort top-to-bottom, left-to-right for consistent downstream ordering
        deduped.sort(key=lambda b: (b.y, b.x))

        return DetectionResult(
            boxes=deduped,
            image_width=orig_w,
            image_height=orig_h,
            debug={
                "model": MODEL_ID,
                "query": TEXT_QUERY,
                "box_threshold": BOX_THRESHOLD,
                "text_threshold": TEXT_THRESHOLD,
                "raw_count": int(len(boxes_tensor)),
                "rejected_too_large": rejected_too_large,
                "after_area_filter": len(boxes),
                "dropped_off_axis": dropped_off_axis,
                "kept": len(deduped),
                "labels": [str(l) for l in labels[:10]],
            },
        )

    @staticmethod
    def _iou(a: BoundingBox, b: BoundingBox) -> float:
        ax1, ay1, ax2, ay2 = a.x, a.y, a.x + a.width, a.y + a.height
        bx1, by1, bx2, by2 = b.x, b.y, b.x + b.width, b.y + b.height
        iw = max(0, min(ax2, bx2) - max(ax1, bx1))
        ih = max(0, min(ay2, by2) - max(ay1, by1))
        inter = iw * ih
        if inter == 0:
            return 0.0
        union = a.width * a.height + b.width * b.height - inter
        return inter / union if union > 0 else 0.0
