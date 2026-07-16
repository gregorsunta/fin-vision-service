import type { ParsedStatement } from '../types.js';

export interface LocalStatementParser {
  id: string;
  /** Cheap detection against the extracted text (header/BIC/branding strings). */
  matches(text: string): boolean;
  /**
   * Structurally parses an ALREADY FULLY REDACTED statement (via
   * redactPIIWithNLP — structural whitelist pass + NER, run once on the
   * whole document upstream). Isolated per-field redaction was tried and
   * reverted: a short extracted fragment (e.g. a 2-3 word Opis field) gives
   * the NER model no surrounding sentence context to calibrate on, which
   * made it both miss real names it would catch in full-document context
   * and wrongly nuke merchant names that are legitimately all-caps in
   * isolation. Whole-document redaction first avoids both failure modes.
   *
   * Returns null if the format matched but no transaction rows could be
   * parsed — caller falls back to the AI-assisted flow.
   */
  parse(text: string): ParsedStatement | null;
}
