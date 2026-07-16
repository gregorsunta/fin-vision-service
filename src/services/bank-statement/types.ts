export type StatementParserKind = 'native-pdf' | 'pdfplumber' | 'csv' | 'xlsx' | 'ocr-ai' | 'local-rules';

export interface ParsedStatementAccount {
  iban?: string;
  accountName?: string;
  bankName?: string;
  currency?: string;
}

export interface ParsedStatementPeriod {
  periodStart?: Date;
  periodEnd?: Date;
  openingBalance?: number;
  closingBalance?: number;
  totalDebit?: number;
  totalCredit?: number;
}

export interface ParsedTransaction {
  transactionDate: Date;
  valueDate?: Date;
  /**
   * Free-text description / namen plačila. PII has already been stripped
   * (emails, phones, foreign IBANs, addresses, individual names). Company
   * names and reasons survive — that's what we keep for matching/display.
   */
  description?: string;
  debit?: number;
  credit?: number;
  runningBalance?: number;
  currency: string;
  confidenceScores?: {
    date: number;
    amount: number;
    description: number;
  };
}

export interface ParsingWarning {
  code: string;
  message: string;
  row?: number;
}

export interface ParsedStatement {
  parser: StatementParserKind;
  parserVersion?: string;
  account: ParsedStatementAccount;
  period: ParsedStatementPeriod;
  transactions: ParsedTransaction[];
  warnings: ParsingWarning[];
  /** Raw sidecar info specific to the parser (bank mapping name, PDF page count, etc). */
  extra?: Record<string, unknown>;
}
