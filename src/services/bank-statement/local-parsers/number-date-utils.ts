/**
 * Deterministic European number/date parsing shared by local statement
 * parsers. No inference — every rule here is a fixed transform, unlike the
 * AI prompt's equivalent instructions in pdf-ai-parser.ts.
 */

// European format: "." is the thousands separator, "," is the decimal
// separator. "1.234,56" -> 1234.56. Never treat "." as a decimal point here —
// these parsers only ever see comma-decimal amounts (see MONEY_RE below).
export function parseEuropeanNumber(raw: string): number {
  return Number(raw.replace(/\./g, '').replace(',', '.'));
}

// Matches a European money value with exactly 2 decimal places, e.g. "1.234,56"
// or "43,01". Requires a comma — this is what lets local parsers distinguish
// amounts from transaction IDs, phone-like tokens, or reference codes, none of
// which use a comma.
export const MONEY_RE = /\d[\d.]*,\d{2}/g;

const MONTH_LOOKUP: Record<string, number> = {
  jan: 1, januar: 1, january: 1,
  feb: 2, februar: 2, february: 2,
  mar: 3, marec: 3, march: 3,
  apr: 4, april: 4,
  maj: 5, may: 5,
  jun: 6, junij: 6, june: 6,
  jul: 7, julij: 7, july: 7,
  avg: 8, aug: 8, avgust: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Parses a Slovenian/English month name or abbreviation (case-insensitive, trailing dot optional). */
export function monthFromToken(token: string): number | undefined {
  return MONTH_LOOKUP[token.replace(/\.$/, '').toLowerCase()];
}

/** Builds a UTC Date from numeric day/month/year, or null if out of range. */
export function makeDate(day: number, month: number, year: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return isNaN(date.getTime()) ? null : date;
}
