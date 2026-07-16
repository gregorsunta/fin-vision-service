/**
 * PII redactor for bank statement content.
 *
 * Strategy: targeted blacklist.
 *
 * Structured patterns (email, phone, IBAN, tax ID, postal address) are replaced
 * with placeholder tokens. Everything else — including merchant and company names
 * — is preserved so the AI has full transaction context.
 *
 * Personal names in transfer descriptions are detected by the pii-detector
 * sidecar (Presidio + spaCy) via `redactPIIWithNLP`. Use plain `redactPII` for
 * defence-in-depth passes on already-redacted text (sync, no sidecar call).
 */

import { createLogger } from '../../utils/logger.js';
import { findIbanInText, ibanExpectedLength, normalizeIban } from './iban-utils.js';
import { redactPersonNames } from './pii-name-detector.js';

const log = createLogger('services.bank-statement.pii-filter');

// ---------------------------------------------------------------------------
// Structured-pattern passes
// ---------------------------------------------------------------------------

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// Slovenian phone formats. Inline whitespace only — phones don't span lines.
const SI_PHONE_RE = /(?:\+386|00386|\b0)[ \t]?\d{1,2}[ \t/-]?\d{3}[ \t/-]?\d{3,4}/g;
const INTL_PHONE_RE = /\+\d{1,3}[ \t]?\d{6,12}/g;

// IBAN: inline whitespace only — `\s` would cross newlines and over-match.
// The {11,31} quantifier is intentionally greedy (to span space-separated
// IBAN groups like "SI56 0201 0001 2345 678"), which means it routinely
// consumes past the real IBAN's end into whatever alphanumeric text follows
// — observed eating the leading digits of the *next* column's amount on
// tightly-packed statement rows (e.g. "SI56...678200,00" -> IBAN match
// swallows "678200", leaving only ",00" of the amount). splitIbanMatch()
// below trims the match back to the country's real length before redacting,
// same fix already applied in findIbanInText.
const IBAN_RE = /[A-Z]{2}\d{2}(?:[ \t]?[A-Z0-9]){11,31}/g;

/**
 * Splits a greedy IBAN_RE match into the real IBAN prefix (per the country's
 * known length) and whatever trailing text was over-consumed, which must be
 * preserved rather than swallowed by the redaction token.
 */
function splitIbanMatch(raw: string): { used: string; leftover: string } {
  const countryCode = raw.slice(0, 2).toUpperCase();
  const expectedLen = ibanExpectedLength(countryCode);
  if (!expectedLen) return { used: raw, leftover: '' };

  let alnumCount = 0;
  let i = 0;
  for (; i < raw.length; i++) {
    if (/[A-Za-z0-9]/.test(raw[i])) alnumCount++;
    if (alnumCount === expectedLen) {
      i++;
      break;
    }
  }
  return { used: raw.slice(0, i), leftover: raw.slice(i) };
}

// SI tax ID / company registration numbers.
const SI_TAX_ID_RE = /\bSI\d{8}\b|\b\d{8}\b(?=\s*(?:DDV|davčna|tax))/gi;

// SI postal address: 4-digit postcode at line start followed by city. Anchored
// so a 4-digit year mid-line never matches as a postcode.
const ADDR_RE = /^[ \t]*\d{4}[ \t]+\S+(?:[ \t]+\S+)?/gm;

// Street address on its own line: word(s) + house number (1–4 digits + optional
// letter/fraction). Anchored to line boundaries so mid-line amounts (e.g.
// "150,00") are never matched — those always have a decimal comma.
// Handles: "ZGORNJA HAJDINA 100A", "Dunajska cesta 5", "Prešernova 12/3b".
const STREET_ADDR_RE = /^[ \t]*\p{L}[\p{L}\p{M}' ]{2,}[ \t]+\d{1,4}[A-Za-z]?(?:\/\d+)?[ \t]*$/gmu;

// ---------------------------------------------------------------------------
// Transfer counterparty pass (default-deny for P2P bank-transfer fields)
// ---------------------------------------------------------------------------
//
// Merchant names are an open, unenumerable set (any shop can appear on a
// statement), which is why they're left to the NER sidecar rather than a
// list. But institutions/companies named as a *transfer counterparty*
// ("Prejemnik:"/"Plačnik:"/"To:"/"From:") are a small, enumerable set —
// legal-entity suffixes plus a handful of Slovenian government keyword
// stems. So for this specific field we can safely default-deny: redact
// unless the value matches the whitelist, rather than relying on NER, which
// has been observed to miss foreign-language names entirely when the wrong
// language model analyses the surrounding (mostly differently-languaged)
// document. Keep this list in sync with `_INSTITUTIONAL_KEYWORDS` in
// pii-detector-service/detector.py (used there to stop NER doing the reverse
// mistake — tagging these same institutions as PERSON).
const INSTITUTIONAL_KEYWORDS = [
  'd.o.o', 'd.d.', 's.p.', 'z.o.o', 'gmbh', 'ltd', 'uab', 's.r.o', 'plc',
  'obcin', 'obč', 'ministrstv', 'mddsz', 'zavod', 'zzzs', 'furs', 'durs',
  'uprav', 'davk', 'davč', 'davc', 'prispevk', 'neposredn', 'placil', 'plačil',
  'sklad', 'agencij', 'banka', 'skupnost', 'republi',
];

export function isInstitutional(candidate: string): boolean {
  // Reference/batch codes ("ACD-NEPOSREDNA", account numbers) are not personal
  // names either way, so any digit is enough to exempt a span from redaction.
  if (/\d/.test(candidate)) return true;
  const lower = candidate.toLowerCase();
  return INSTITUTIONAL_KEYWORDS.some((kw) => lower.includes(kw));
}

// Label immediately preceding a bank-transfer counterparty name: Revolut
// ("Transfer to/from NAME", "To: NAME", "From: NAME", "Reference: To/From
// NAME") and domestic SEPA-style statements ("Prejemnik: NAME", "Plačnik: NAME").
const TRANSFER_LABEL_RE =
  /\b(?:Transfer\s+to|Transfer\s+from|Reference:\s*(?:To|From)|To\s*:|From\s*:|Prejemnik\s*:|Pla[cč]nik\s*:)\s+([\p{L}][\p{L}\p{M}.\-]*(?:[ \t]+[\p{L}][\p{L}\p{M}.\-]*){0,4})/gimu;

const CARD_LINE_RE = /^\s*Card\s*:/i;

// Same label set as TRANSFER_LABEL_RE, but also accepts a bare "To NAME" /
// "From NAME" (no colon) — Revolut generates transaction *titles* in this
// shape (e.g. "To Občina Podlehnik"), unlike the "To:"/"From:" continuation
// lines below them. Safe to be this permissive only because callers apply it
// to a single, already-isolated title field (a local statement parser's
// extracted description), never to a full free-text document — a bare "to"/
// "from" is far too common in ordinary prose for that.
const BARE_TRANSFER_TITLE_RE =
  /^(?:Transfer\s+to|Transfer\s+from|To|From)\s+([\p{L}][\p{L}\p{M}.\-]*(?:[ \t]+[\p{L}][\p{L}\p{M}.\-]*){0,4})/u;

/**
 * Redacts a counterparty name from an isolated transaction-title string
 * (e.g. a Revolut row title extracted by a local statement parser), using
 * the same institutional whitelist as `redactTransferCounterparties`.
 */
export function redactTransferTitle(title: string): string {
  const m = BARE_TRANSFER_TITLE_RE.exec(title);
  if (!m) return title;
  const candidate = m[1];
  if (isInstitutional(candidate)) return title;
  const matchEnd = m.index + m[0].length;
  return title.slice(0, matchEnd - candidate.length) + '[OSEBA]' + title.slice(matchEnd);
}

/**
 * Redacts individual names in bank-transfer counterparty fields that the
 * open-set NER pass can miss (e.g. a Slovenian name embedded in an English
 * Revolut statement, analysed by the wrong-language model). Card purchases
 * are exempted — identified by an adjacent "Card:" line — since merchant
 * names must stay visible for AI categorisation; anything else in this
 * field is redacted unless it matches a known institutional/company marker.
 */
function redactTransferCounterparties(text: string): { text: string; count: number } {
  const lines = text.split('\n');
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const isCardPurchase = CARD_LINE_RE.test(lines[i + 1] ?? '') || CARD_LINE_RE.test(lines[i + 2] ?? '');
    if (isCardPurchase) continue;

    lines[i] = lines[i].replace(TRANSFER_LABEL_RE, (full: string, candidate: string) => {
      if (isInstitutional(candidate)) return full;
      count++;
      return full.slice(0, full.length - candidate.length) + '[OSEBA]';
    });
  }

  return { text: lines.join('\n'), count };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countAndReplace(
  input: string,
  regex: RegExp,
  replacement: string | ((match: string) => string),
): { text: string; count: number } {
  let count = 0;
  const text = input.replace(regex, (match: string, ..._rest: unknown[]) => {
    const out = typeof replacement === 'function' ? replacement(match) : replacement;
    if (out !== match) count++;
    return out;
  });
  return { text, count };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RedactionResult {
  text: string;
  /** Replacement counts per category, for monitoring / quality tracking. */
  replacements: {
    emails: number;
    phones: number;
    ibans: number;
    addresses: number;
    taxIds: number;
    /** Personal names detected by NLP sidecar (0 when sidecar not called). */
    persons: number;
  };
}

export interface RedactionOptions {
  /**
   * The user's own account IBAN. Preserved so the AI can verify the statement
   * was assigned to the correct account. All other IBANs are redacted.
   */
  primaryIban?: string;
}

/**
 * Synchronous structured-pattern pass only. Redacts emails, phones, IBANs,
 * tax IDs, and postal addresses. Merchant and company names are preserved.
 *
 * Use this for defence-in-depth passes on text that is already partially
 * redacted (e.g. AI output post-processing). `persons` in the result is always 0.
 */
export function redactPII(input: string, opts: RedactionOptions = {}): RedactionResult {
  const stats = { emails: 0, phones: 0, ibans: 0, addresses: 0, taxIds: 0, persons: 0 };
  let text = input;

  ({ text, count: stats.emails } = countAndReplace(text, EMAIL_RE, '[EMAIL]'));

  let phoneCount = 0;
  ({ text, count: phoneCount } = countAndReplace(text, SI_PHONE_RE, '[PHONE]'));
  stats.phones = phoneCount;
  ({ text, count: phoneCount } = countAndReplace(text, INTL_PHONE_RE, '[PHONE]'));
  stats.phones += phoneCount;

  const primary = opts.primaryIban ? normalizeIban(opts.primaryIban) : undefined;
  ({ text, count: stats.ibans } = countAndReplace(text, IBAN_RE, (match) => {
    const { used, leftover } = splitIbanMatch(match);
    const normalized = normalizeIban(used);
    if (primary && normalized === primary) return used + leftover;
    // Keep last 6 chars for account-matching fallback (see bankStatementProcessor).
    const suffix = normalized.slice(-6);
    const token = suffix ? `[IBAN…${suffix}]` : '[IBAN]';
    return token + leftover;
  }));

  ({ text, count: stats.taxIds } = countAndReplace(text, SI_TAX_ID_RE, '[TAXID]'));
  ({ text, count: stats.addresses } = countAndReplace(text, ADDR_RE, '[ADDR]'));
  let streetCount = 0;
  ({ text, count: streetCount } = countAndReplace(text, STREET_ADDR_RE, '[ADDR]'));
  stats.addresses += streetCount;

  ({ text, count: stats.persons } = redactTransferCounterparties(text));

  return { text, replacements: stats };
}

/**
 * Full redaction pipeline including NLP-based personal name detection via the
 * pii-detector sidecar (Presidio + spaCy). Use this for Phase 1 of statement
 * processing — the main redaction pass before user review.
 *
 * Falls back to structured-only redaction if the sidecar is unavailable.
 */
export async function redactPIIWithNLP(input: string, opts: RedactionOptions = {}): Promise<RedactionResult> {
  const result = redactPII(input, opts);
  try {
    const { text, persons } = await redactPersonNames(result.text);
    // Sum, don't overwrite — redactPII already redacted some names via the
    // structured transfer-counterparty pass above.
    return { text, replacements: { ...result.replacements, persons: result.replacements.persons + persons } };
  } catch (err) {
    // Sidecar unavailable — structured redaction is still applied, but personal
    // names in transfer descriptions will NOT be redacted. Log so it's visible.
    log.warn({ err }, 'pii-detector sidecar unavailable — personal names may not be redacted');
    return result;
  }
}

/**
 * Convenience wrapper for nullable fields. Returns null when the input is
 * empty; strips structured PII and returns the redacted string otherwise.
 * Does not call the NLP sidecar.
 */
export function redactField(value: string | null | undefined, opts: RedactionOptions = {}): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return redactPII(trimmed, opts).text;
}

/**
 * Pre-flight IBAN scan. Call BEFORE redactPII so the primary IBAN can be
 * preserved rather than stripped. Caller handles ownership verification.
 */
export function detectPrimaryIban(text: string): string | undefined {
  return findIbanInText(text) ?? undefined;
}
