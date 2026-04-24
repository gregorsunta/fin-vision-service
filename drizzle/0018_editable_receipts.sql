CREATE TABLE `receipt_edit_history` (
  `id` serial PRIMARY KEY,
  `entity_type` enum('receipt','line_item') NOT NULL,
  `entity_id` int NOT NULL,
  `field_name` varchar(100) NOT NULL,
  `old_value` text,
  `new_value` text,
  `changed_by` int NOT NULL,
  `changed_at` timestamp NOT NULL DEFAULT (now()),
  INDEX `idx_entity` (`entity_type`, `entity_id`, `field_name`, `changed_at`)
);
--> statement-breakpoint
ALTER TABLE `receipts` ADD COLUMN `edited_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `line_items` ADD COLUMN `deleted_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `line_items` ADD COLUMN `is_user_added` boolean NOT NULL DEFAULT false;
