ALTER TABLE `receipts` ADD COLUMN `user_receipt_number` int NULL;
--> statement-breakpoint

UPDATE `receipts` r
JOIN (
  SELECT r2.id,
    ROW_NUMBER() OVER (PARTITION BY ru.user_id ORDER BY r2.id) AS rn
  FROM `receipts` r2
  JOIN `receipt_uploads` ru ON ru.id = r2.upload_id
) ranked ON ranked.id = r.id
SET r.user_receipt_number = ranked.rn;
--> statement-breakpoint

ALTER TABLE `receipts` MODIFY COLUMN `user_receipt_number` int NOT NULL;
--> statement-breakpoint

ALTER TABLE `receipt_uploads` ADD UNIQUE INDEX `uq_user_upload_number` (`user_id`, `upload_number`);
