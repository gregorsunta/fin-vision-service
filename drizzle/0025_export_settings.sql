-- Per-user CSV export format preferences.
ALTER TABLE `users` ADD COLUMN `export_settings` JSON NULL;
