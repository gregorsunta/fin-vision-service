// src/services/csvGenerator.ts

interface LineItem {
  id: number;
  receiptId: number;
  itemType: string;
  description: string;
  amount: string | null;
  unit: string | null;
  pricePerUnit: string | null;
  totalPrice: string;
  keywords: string[] | null;
}

interface Receipt {
  id: number;
  uploadId: number;
  storeName: string | null;
  totalAmount: string | null;
  taxAmount: string | null;
  currency: string | null;
  transactionDate: Date | null;
  status: string;
  reviewStatus: string | null;
  keywords: string[] | null;
  lineItems: LineItem[];
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
const quote = (value: string | null | undefined) =>
  `"${String(value || '').replace(doubleQuoteRegex, '""')}"`;

function formatDate(date: Date | string | null): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().split('T')[0];
}

function formatKeywords(keywords: string[] | null | undefined): string {
  if (!keywords || !Array.isArray(keywords)) return '';
  return keywords.join('; ');
}

/**
 * One row per line item, with receipt context.
 */
export function generateItemsCsv(receipts: Receipt[]): string {
  if (!receipts.length) return '';

  const headers = [
    'Item ID', 'Receipt ID', 'Upload ID', 'Store Name', 'Item Type',
    'Description', 'Quantity', 'Unit', 'Price Per Unit', 'Total Price',
    'Currency', 'Transaction Date', 'Keywords',
  ];
  let csv = headers.join(',') + '\n';

  for (const receipt of receipts) {
    if (!receipt.lineItems?.length) continue;
    for (const item of receipt.lineItems) {
      csv += [
        item.id,
        receipt.id,
        receipt.uploadId,
        quote(receipt.storeName),
        quote(item.itemType),
        quote(item.description),
        quote(item.amount),
        quote(item.unit),
        quote(item.pricePerUnit),
        quote(item.totalPrice),
        quote(receipt.currency),
        quote(formatDate(receipt.transactionDate)),
        quote(formatKeywords(item.keywords)),
      ].join(',') + '\n';
    }
  }

  return csv;
}

/**
 * One row per receipt, no line items.
 */
export function generateReceiptsCsv(receipts: Receipt[]): string {
  if (!receipts.length) return '';

  const headers = [
    'Receipt ID', 'Upload ID', 'Store Name', 'Total Amount', 'Tax Amount',
    'Currency', 'Transaction Date', 'Status', 'Review Status', 'Keywords',
  ];
  let csv = headers.join(',') + '\n';

  for (const receipt of receipts) {
    csv += [
      receipt.id,
      receipt.uploadId,
      quote(receipt.storeName),
      quote(receipt.totalAmount),
      quote(receipt.taxAmount),
      quote(receipt.currency),
      quote(formatDate(receipt.transactionDate)),
      quote(receipt.status),
      quote(receipt.reviewStatus ?? 'not_required'),
      quote(formatKeywords(receipt.keywords)),
    ].join(',') + '\n';
  }

  return csv;
}

/**
 * One row per upload with aggregate statistics.
 */
export function generateUploadsCsv(uploads: Upload[]): string {
  if (!uploads.length) return '';

  const headers = [
    'Upload ID', 'File Name', 'Status', 'Total Detected', 'Successful',
    'Failed', 'Processing', 'Created At', 'Updated At',
  ];
  let csv = headers.join(',') + '\n';

  for (const upload of uploads) {
    csv += [
      upload.uploadId,
      quote(upload.fileName),
      quote(upload.status),
      upload.statistics.totalDetected,
      upload.statistics.successful,
      upload.statistics.failed,
      upload.statistics.processing,
      quote(formatDate(upload.createdAt)),
      quote(formatDate(upload.updatedAt)),
    ].join(',') + '\n';
  }

  return csv;
}
