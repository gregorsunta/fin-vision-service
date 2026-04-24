// src/services/csvGenerator.ts

export interface ExportOptions {
  decimalSeparator: '.' | ',';
  amountFormat: 'decimal' | 'cents' | 'integer4dp';
  dateFormat: 'YYYY-MM-DD' | 'DD.MM.YYYY' | 'MM/DD/YYYY';
  includeCurrency: boolean;
  includeHeader: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  decimalSeparator: '.',
  amountFormat: 'decimal',
  dateFormat: 'YYYY-MM-DD',
  includeCurrency: true,
  includeHeader: true,
};

export interface CsvLineItem {
  id: number;
  receiptId: number;
  itemType: string | null;
  description: string;
  amount: string | null;
  unit: string | null;
  pricePerUnit: string | null;
  totalPrice: string;
  keywords: unknown;
}

export interface CsvReceipt {
  id: number;
  uploadId: number;
  storeName: string | null;
  totalAmount: string | null;
  taxAmount: string | null;
  currency: string | null;
  transactionDate: Date | null;
  status: string;
  reviewStatus: string | null;
  keywords: unknown;
  lineItems?: CsvLineItem[];
}

interface Upload {
  uploadId: number;
  fileName: string;
  status: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  statistics: {
    totalDetected: number;
    successful: number;
    failed: number;
    processing: number;
  };
}

const doubleQuoteRegex = /"/g;

function quote(value: string | null | undefined): string {
  return `"${String(value || '').replace(doubleQuoteRegex, '""')}"`;
}

function formatAmount(value: string | null | undefined, opts: ExportOptions): string {
  if (!value) return '';
  const n = parseFloat(value);
  if (isNaN(n)) return '';

  if (opts.amountFormat === 'cents') return String(Math.round(n * 100));
  if (opts.amountFormat === 'integer4dp') return String(Math.round(n * 10000));

  // decimal — respect separator
  const s = n.toFixed(2);
  return opts.decimalSeparator === ',' ? s.replace('.', ',') : s;
}

function formatDate(date: Date | string | null, opts: ExportOptions): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  switch (opts.dateFormat) {
    case 'DD.MM.YYYY': return `${D}.${M}.${Y}`;
    case 'MM/DD/YYYY': return `${M}/${D}/${Y}`;
    default:           return `${Y}-${M}-${D}`;
  }
}

function formatKeywords(keywords: unknown): string {
  if (!Array.isArray(keywords)) return '';
  return keywords.filter((k): k is string => typeof k === 'string').join('; ');
}

// European CSV uses ; as delimiter when , is the decimal separator
function sep(opts: ExportOptions): string {
  return opts.decimalSeparator === ',' ? ';' : ',';
}

/**
 * One row per line item, with receipt context.
 */
export function generateItemsCsv(receipts: CsvReceipt[], opts: ExportOptions = DEFAULT_EXPORT_OPTIONS): string {
  if (!receipts.length) return '';

  const s = sep(opts);
  const headers = [
    'Item ID', 'Receipt ID', 'Upload ID', 'Store Name', 'Item Type',
    'Description', 'Quantity', 'Unit', 'Price Per Unit', 'Total Price',
    ...(opts.includeCurrency ? ['Currency'] : []),
    'Transaction Date', 'Keywords',
  ];

  const rows: string[] = opts.includeHeader ? [headers.join(s)] : [];

  for (const receipt of receipts) {
    if (!receipt.lineItems?.length) continue;
    for (const item of receipt.lineItems) {
      const cols = [
        item.id,
        receipt.id,
        receipt.uploadId,
        quote(receipt.storeName),
        quote(item.itemType),
        quote(item.description),
        formatAmount(item.amount, opts) || quote(item.amount),
        quote(item.unit),
        formatAmount(item.pricePerUnit, opts),
        formatAmount(item.totalPrice, opts),
        ...(opts.includeCurrency ? [quote(receipt.currency)] : []),
        quote(formatDate(receipt.transactionDate, opts)),
        quote(formatKeywords(item.keywords)),
      ];
      rows.push(cols.join(s));
    }
  }

  return rows.join('\n') + '\n';
}

/**
 * One row per receipt, no line items.
 */
export function generateReceiptsCsv(receipts: CsvReceipt[], opts: ExportOptions = DEFAULT_EXPORT_OPTIONS): string {
  if (!receipts.length) return '';

  const s = sep(opts);
  const headers = [
    'Receipt ID', 'Upload ID', 'Store Name', 'Total Amount', 'Tax Amount',
    ...(opts.includeCurrency ? ['Currency'] : []),
    'Transaction Date', 'Status', 'Review Status', 'Keywords',
  ];

  const rows: string[] = opts.includeHeader ? [headers.join(s)] : [];

  for (const receipt of receipts) {
    const cols = [
      receipt.id,
      receipt.uploadId,
      quote(receipt.storeName),
      formatAmount(receipt.totalAmount, opts),
      formatAmount(receipt.taxAmount, opts),
      ...(opts.includeCurrency ? [quote(receipt.currency)] : []),
      quote(formatDate(receipt.transactionDate, opts)),
      quote(receipt.status),
      quote(receipt.reviewStatus ?? 'not_required'),
      quote(formatKeywords(receipt.keywords)),
    ];
    rows.push(cols.join(s));
  }

  return rows.join('\n') + '\n';
}

/**
 * One row per upload with aggregate statistics.
 */
export function generateUploadsCsv(uploads: Upload[], opts: ExportOptions = DEFAULT_EXPORT_OPTIONS): string {
  if (!uploads.length) return '';

  const s = sep(opts);
  const headers = [
    'Upload ID', 'File Name', 'Status', 'Total Detected', 'Successful',
    'Failed', 'Processing', 'Created At', 'Updated At',
  ];

  const rows: string[] = opts.includeHeader ? [headers.join(s)] : [];

  for (const upload of uploads) {
    const cols = [
      upload.uploadId,
      quote(upload.fileName),
      quote(upload.status),
      upload.statistics.totalDetected,
      upload.statistics.successful,
      upload.statistics.failed,
      upload.statistics.processing,
      quote(formatDate(upload.createdAt, opts)),
      quote(formatDate(upload.updatedAt, opts)),
    ];
    rows.push(cols.join(s));
  }

  return rows.join('\n') + '\n';
}
