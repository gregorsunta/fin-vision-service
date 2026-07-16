import type { ParsedStatement } from '../types.js';
import { otpSiParser } from './otp-si.js';
import { revolutParser } from './revolut.js';
import type { LocalStatementParser } from './types.js';

const PARSERS: LocalStatementParser[] = [otpSiParser, revolutParser];

/**
 * Tries each known bank-format adapter against already-redacted text.
 * Returns null if no adapter recognises the format, or if the matched
 * adapter found no parseable transaction rows — either way, the caller
 * falls back to the AI-assisted flow rather than persisting a wrong/empty
 * result.
 */
export function tryLocalParse(text: string): ParsedStatement | null {
  for (const parser of PARSERS) {
    if (parser.matches(text)) {
      return parser.parse(text);
    }
  }
  return null;
}
