ALTER TABLE `receipts` MODIFY COLUMN `status` enum('pending','processed','failed','unreadable','rate_limited') NOT NULL DEFAULT 'pending';
