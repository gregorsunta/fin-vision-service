import { SchemaType } from '@google/generative-ai';

/**
 * Gemini JSON schema for bank statement extraction. Separate from the receipt
 * schema because the domain is different (account metadata, transaction list
 * rather than merchant + line items). Prompt caller is in
 * `services/bank-statement/pdf-ai-parser.ts`.
 */
export const statementExtractionSchema = {
  type: SchemaType.OBJECT,
  properties: {
    notAStatement: { type: SchemaType.BOOLEAN, nullable: true },
    iban: { type: SchemaType.STRING, nullable: true },
    accountHolder: { type: SchemaType.STRING, nullable: true },
    bankName: { type: SchemaType.STRING, nullable: true },
    currency: { type: SchemaType.STRING, nullable: true },
    periodStart: { type: SchemaType.STRING, nullable: true, description: 'YYYY-MM-DD' },
    periodEnd: { type: SchemaType.STRING, nullable: true, description: 'YYYY-MM-DD' },
    openingBalance: { type: SchemaType.NUMBER, nullable: true },
    closingBalance: { type: SchemaType.NUMBER, nullable: true },
    totalDebit: { type: SchemaType.NUMBER, nullable: true },
    totalCredit: { type: SchemaType.NUMBER, nullable: true },
    transactions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          transactionDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
          valueDate: { type: SchemaType.STRING, nullable: true, description: 'YYYY-MM-DD' },
          // Single description field — PII has already been stripped from the
          // input you receive, so respond using the same redacted text.
          description: { type: SchemaType.STRING, nullable: true },
          debit: { type: SchemaType.NUMBER, nullable: true, description: 'Positive amount when money left the account. Null if this row is a credit.' },
          credit: { type: SchemaType.NUMBER, nullable: true, description: 'Positive amount when money entered the account. Null if this row is a debit.' },
          runningBalance: { type: SchemaType.NUMBER, nullable: true },
          confidence: { type: SchemaType.NUMBER, nullable: true, description: '0..1 — how confident you are in this row' },
        },
        required: ['transactionDate'],
      },
    },
    warnings: {
      type: SchemaType.ARRAY,
      nullable: true,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          code: { type: SchemaType.STRING },
          message: { type: SchemaType.STRING },
        },
        required: ['code', 'message'],
      },
    },
  },
  required: ['transactions'],
};

export interface StatementExtractionResult {
  notAStatement?: boolean;
  iban?: string;
  accountHolder?: string;
  bankName?: string;
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: number;
  closingBalance?: number;
  totalDebit?: number;
  totalCredit?: number;
  transactions: Array<{
    transactionDate: string;
    valueDate?: string;
    description?: string;
    debit?: number;
    credit?: number;
    runningBalance?: number;
    confidence?: number;
  }>;
  warnings?: Array<{ code: string; message: string }>;
}
