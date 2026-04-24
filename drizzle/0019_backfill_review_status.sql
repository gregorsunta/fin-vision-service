-- Backfill review_status for receipts that have VALIDATION_WARNING errors
-- but were processed before the review_status column was added (migration 0017).
-- Those receipts got the column default 'not_required' instead of 'needs_review'.
UPDATE `receipts` r
INNER JOIN `processing_errors` pe ON pe.`receipt_id` = r.`id`
SET r.`review_status` = 'needs_review'
WHERE pe.`category` = 'VALIDATION_WARNING'
  AND r.`review_status` = 'not_required'
  AND r.`status` = 'processed';
