-- Add discount_per_unit and unit_price_ex_vat to line_items.
-- discount_per_unit: per-row discount column (absolute amount per unit), present on some EU receipts.
-- unit_price_ex_vat: unit price excluding VAT, for receipts that show both ex-VAT and incl-VAT columns.
ALTER TABLE `line_items` ADD COLUMN `discount_per_unit` DECIMAL(13,4) NULL AFTER `price_per_unit`;
ALTER TABLE `line_items` ADD COLUMN `unit_price_ex_vat` DECIMAL(13,4) NULL AFTER `discount_per_unit`;
