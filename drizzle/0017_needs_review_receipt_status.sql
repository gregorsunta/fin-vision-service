ALTER TABLE `receipts` ADD COLUMN `review_status` enum('not_required','needs_review','reviewed') NOT NULL DEFAULT 'not_required';
