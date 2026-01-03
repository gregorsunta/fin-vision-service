CREATE TABLE `line_items` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`receipt_id` int NOT NULL,
	`description` varchar(255) NOT NULL,
	`quantity` decimal(10,3) DEFAULT '1.0',
	`unit_price` decimal(10,2) NOT NULL,
	CONSTRAINT `line_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`store_name` varchar(255),
	`total_amount` decimal(10,2),
	`tax_amount` decimal(10,2),
	`transaction_date` date,
	`status` enum('pending','completed','failed') NOT NULL DEFAULT 'pending',
	`image_url` varchar(2048),
	CONSTRAINT `receipts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`api_key` varchar(255) NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_api_key_unique` UNIQUE(`api_key`)
);
