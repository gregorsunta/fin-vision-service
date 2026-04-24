-- Adds missing indexes for common query patterns.
-- Covers: receipts filtered by upload/status/review_status,
-- line_items by receipt, processing_errors by upload,
-- duplicate_matches by either receipt column.
-- Safe to run multiple times — CREATE INDEX IF NOT EXISTS.

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_receipts_upload_id` ON `receipts` (`upload_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_receipts_status` ON `receipts` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_receipts_review_status` ON `receipts` (`review_status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_line_items_receipt_id` ON `line_items` (`receipt_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_processing_errors_upload_id` ON `processing_errors` (`upload_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_duplicate_matches_receipt_id` ON `duplicate_matches` (`receipt_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_duplicate_matches_potential_id` ON `duplicate_matches` (`potential_duplicate_id`);
