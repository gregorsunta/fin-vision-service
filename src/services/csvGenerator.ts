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
  deletedAt?: Date | string | null;
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
  itemsNonReadable?: boolean;
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
 * One row per receipt. Includes item count and top-5 most expensive items as context columns.
 */
export function generateReceiptsCsv(receipts: CsvReceipt[], opts: ExportOptions = DEFAULT_EXPORT_OPTIONS): string {
  if (!receipts.length) return '';

  const s = sep(opts);
  const headers = [
    'Receipt ID', 'Upload ID', 'Store Name', 'Total Amount', 'Tax Amount',
    ...(opts.includeCurrency ? ['Currency'] : []),
    'Transaction Date', 'Status', 'Review Status', 'Keywords',
    'Item Count', 'Top 5 Items',
  ];

  const rows: string[] = opts.includeHeader ? [headers.join(s)] : [];

  for (const receipt of receipts) {
    let itemCount: string;
    let top5Items: string;

    if (receipt.itemsNonReadable) {
      itemCount = 'N/A';
      top5Items = 'N/A';
    } else {
      const activeItems = (receipt.lineItems ?? []).filter(item => !item.deletedAt);
      itemCount = String(activeItems.length);
      const top5 = [...activeItems]
        .filter(item => item.totalPrice && !isNaN(parseFloat(item.totalPrice)))
        .sort((a, b) => parseFloat(b.totalPrice) - parseFloat(a.totalPrice))
        .slice(0, 5);
      top5Items = top5
        .map(item => `${item.description}(${formatAmount(item.totalPrice, opts)}${receipt.currency ?? ''})`)
        .join(' | ');
    }

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
      quote(itemCount),
      quote(top5Items),
    ];
    rows.push(cols.join(s));
  }

  return rows.join('\n') + '\n';
}

// --- Bank statement exports ---

export interface CsvBankTransaction {
  id: number;
  statementUploadId: number;
  bankAccountId: number;
  bankAccountIban?: string | null;
  bankAccountName?: string | null;
  transactionDate: Date | string | null;
  valueDate?: Date | string | null;
  description: string | null;
  debit: string | null;
  credit: string | null;
  runningBalance?: string | null;
  currency: string | null;
  category?: string | null;
  isDuplicate?: boolean | null;
}

export interface CsvBankStatementUpload {
  id: number;
  uploadNumber: number;
  bankAccountIban?: string | null;
  bankAccountName?: string | null;
  originalFileName: string | null;
  periodStart: Date | string | null;
  periodEnd: Date | string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  totalDebit: string | null;
  totalCredit: string | null;
  status: string;
  createdAt: Date | string;
}

/**
 * One row per bank transaction. Includes the parent statement upload id and
 * the resolved bank-account label so the CSV is self-contained.
 */
export function generateBankTransactionsCsv(
  transactions: CsvBankTransaction[],
  opts: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  if (!transactions.length) return '';

  const s = sep(opts);
  const headers = [
    'Transaction ID', 'Statement Upload ID', 'Bank Account', 'IBAN',
    'Date', 'Value Date', 'Description',
    'Debit', 'Credit', 'Running Balance',
    ...(opts.includeCurrency ? ['Currency'] : []),
    'Category', 'Duplicate',
  ];

  const rows: string[] = opts.includeHeader ? [headers.join(s)] : [];

  for (const t of transactions) {
    const cols = [
      t.id,
      t.statementUploadId,
      quote(t.bankAccountName ?? ''),
      quote(t.bankAccountIban ?? ''),
      quote(formatDate(t.transactionDate, opts)),
      quote(formatDate(t.valueDate ?? null, opts)),
      quote(t.description),
      formatAmount(t.debit, opts),
      formatAmount(t.credit, opts),
      formatAmount(t.runningBalance ?? null, opts),
      ...(opts.includeCurrency ? [quote(t.currency)] : []),
      quote(t.category ?? ''),
      quote(t.isDuplicate ? 'yes' : ''),
    ];
    rows.push(cols.join(s));
  }
  return rows.join('\n') + '\n';
}

export function generateBankStatementUploadsCsv(
  uploads: CsvBankStatementUpload[],
  opts: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  if (!uploads.length) return '';
  const s = sep(opts);
  const headers = [
    'Upload ID', 'Upload Number', 'Bank Account', 'IBAN',
    'Original File', 'Period Start', 'Period End',
    'Opening Balance', 'Closing Balance', 'Total Debit', 'Total Credit',
    'Status', 'Created At',
  ];
  const rows: string[] = opts.includeHeader ? [headers.join(s)] : [];
  for (const u of uploads) {
    rows.push([
      u.id,
      u.uploadNumber,
      quote(u.bankAccountName ?? ''),
      quote(u.bankAccountIban ?? ''),
      quote(u.originalFileName),
      quote(formatDate(u.periodStart, opts)),
      quote(formatDate(u.periodEnd, opts)),
      formatAmount(u.openingBalance, opts),
      formatAmount(u.closingBalance, opts),
      formatAmount(u.totalDebit, opts),
      formatAmount(u.totalCredit, opts),
      quote(u.status),
      quote(formatDate(u.createdAt, opts)),
    ].join(s));
  }
  return rows.join('\n') + '\n';
}

export type UnifiedSource = 'matched' | 'bank_statement_only' | 'receipt_only';

export interface CsvUnifiedRow {
  source: UnifiedSource;
  matchConfidence: number | null;
  date: Date | string | null;
  amount: string | null;
  currency: string | null;
  // Bank-side
  transactionId: number | null;
  description: string | null;
  bankAccount: string | null;
  bankAccountIban: string | null;
  // Receipt-side
  receiptId: number | null;
  storeName: string | null;
  receiptNumber: string | null;
  // Admin
  notes?: string;
}

/**
 * Combined export: one row per match (or per orphan transaction / orphan
 * receipt). The `source` column lets the user filter for missing-receipt rows
 * in their accounting tool of choice.
 */
export function generateUnifiedCsv(
  rows: CsvUnifiedRow[],
  opts: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  if (!rows.length) return '';
  const s = sep(opts);
  const headers = [
    'Source', 'Match Confidence', 'Date', 'Amount',
    ...(opts.includeCurrency ? ['Currency'] : []),
    'Transaction ID', 'Description', 'Bank Account', 'Bank IBAN',
    'Receipt ID', 'Store Name', 'Receipt #', 'Notes',
  ];
  const out: string[] = opts.includeHeader ? [headers.join(s)] : [];
  for (const r of rows) {
    out.push([
      quote(r.source),
      r.matchConfidence == null ? '' : r.matchConfidence.toFixed(2),
      quote(formatDate(r.date, opts)),
      formatAmount(r.amount, opts),
      ...(opts.includeCurrency ? [quote(r.currency)] : []),
      r.transactionId ?? '',
      quote(r.description),
      quote(r.bankAccount ?? ''),
      quote(r.bankAccountIban ?? ''),
      r.receiptId ?? '',
      quote(r.storeName),
      quote(r.receiptNumber ?? ''),
      quote(r.notes ?? ''),
    ].join(s));
  }
  return out.join('\n') + '\n';
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
