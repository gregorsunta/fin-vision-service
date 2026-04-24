ALTER TABLE `receipts` ADD COLUMN `items_non_readable` boolean NOT NULL DEFAULT false;
ALTER TABLE `receipts` ADD COLUMN `deleted_at` timestamp NULL;
