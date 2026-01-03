// src/services/csvGenerator.ts

interface LineItem {
  id: number;
  description: string;
  quantity: string | null;
  unitPrice: string;
}

interface Receipt {
  id: number;
  storeName: string | null;
  totalAmount: string | null;
  taxAmount: string | null;
  transactionDate: Date | null;
  imageUrl: string | null;
  userId: number;
  status: 'pending' | 'completed' | 'failed';
  lineItems: LineItem[];
}

/**
 * Generates a CSV string from an array of receipt data, including line items.
 * Each line item for a receipt will result in a separate row in the CSV,
 * with common receipt details repeated.
 * @param receipts An array of receipt objects, potentially including line items.
 * @returns A string containing the CSV data.
 */
export function generateReceiptsCsv(receipts: Receipt[]): string {
  if (!receipts.length) return '';

  const headers = [
    'Receipt ID', 'Store Name', 'Total Amount', 'Tax Amount', 'Transaction Date', 'Image URL',
    'Line Item ID', 'Line Item Description', 'Line Item Quantity', 'Line Item Unit Price'
  ];
  let csvContent = headers.join(',') + '\n';

  // Define the regex outside to avoid template literal parsing issues
  const doubleQuoteRegex = /"/g;
  const quote = (value: string | null | undefined) => `"${String(value || '').replace(doubleQuoteRegex, '""')}"`;

  receipts.forEach(receipt => {
    const commonReceiptFields = [
      receipt.id,
      quote(receipt.storeName),
      quote(receipt.totalAmount),
      quote(receipt.taxAmount),
      quote(receipt.transactionDate ? receipt.transactionDate.toISOString().split('T')[0] : ''),
      quote(receipt.imageUrl)
    ];

    if (receipt.lineItems && receipt.lineItems.length > 0) {
      receipt.lineItems.forEach(item => {
        csvContent += [
          ...commonReceiptFields,
          item.id,
          quote(item.description),
          quote(item.quantity),
          quote(item.unitPrice)
        ].join(',') + '\n';
      });
    } else {
      // Handle receipts with no line items, still output the receipt info
      csvContent += [
        ...commonReceiptFields,
        '', '', '', '' // Empty fields for line item details
      ].join(',') + '\n';
    }
  });

  return csvContent;
}
