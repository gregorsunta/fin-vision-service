/**
 * IBAN parsing and validation helpers. Used by statement parsers to identify
 * which bank_account a statement belongs to.
 *
 * Slovenian banks are prioritized in the lookup table since those are the
 * primary target users; extend as needed.
 */

const IBAN_LENGTHS: Record<string, number> = {
  SI: 19, AT: 20, DE: 22, IT: 27, HR: 21, HU: 28, FR: 27, ES: 24, GB: 22,
  NL: 18, BE: 16, CH: 21, CZ: 24, SK: 24, PL: 28, RO: 24, BG: 22, GR: 27,
  IE: 22, PT: 25, SE: 24, DK: 18, FI: 18, NO: 15, IS: 26, LU: 20, LI: 21,
  MT: 31, CY: 28, EE: 20, LT: 20, LV: 21,
};

/** Expected IBAN length for a 2-letter country code, or undefined if unknown. */
export function ibanExpectedLength(countryCode: string): number | undefined {
  return IBAN_LENGTHS[countryCode.toUpperCase()];
}

/**
 * Mapping from Slovenian bank code (positions 5–6 of IBAN, i.e. the bank code
 * inside the BBAN) to human-readable bank name. Source: Bank of Slovenia
 * public register. Extend for other countries as parsers are added.
 */
const SI_BANK_CODES: Record<string, string> = {
  '01': 'Banka Slovenije',
  '02': 'NLB d.d.',
  '03': 'SKB banka d.d.',
  '04': 'Nova KBM d.d.',
  '05': 'Abanka d.d.',
  '06': 'Banka Celje d.d.',
  '10': 'Banka Intesa Sanpaolo d.d.',
  '14': 'Gorenjska banka d.d.',
  '19': 'Deželna banka Slovenije d.d.',
  '24': 'BKS Bank AG',
  '25': 'Hranilnica LON d.d.',
  '28': 'Sberbank d.d.',
  '29': 'Unicredit Banka Slovenija d.d.',
  '30': 'Sberbank d.d.',
  '33': 'Addiko Bank d.d.',
  '34': 'Banka Sparkasse d.d.',
  '35': 'N Banka d.d.',
  '51': 'Delavska hranilnica d.d.',
  '61': 'Poštna banka Slovenije d.d.',
  '70': 'Primorska hranilnica Vipava d.d.',
};

export interface NormalizedIban {
  iban: string;
  countryCode: string;
  checkDigits: string;
  bban: string;
}

export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/**
 * Validates IBAN structure (length per country) and the mod-97 checksum.
 * Returns normalized IBAN on success, null otherwise.
 */
export function validateIban(input: string): NormalizedIban | null {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return null;

  const countryCode = iban.slice(0, 2);
  const expectedLength = IBAN_LENGTHS[countryCode];
  if (!expectedLength || iban.length !== expectedLength) return null;

  // mod-97 checksum: move first 4 chars to end, letters → numbers (A=10..Z=35), mod 97 == 1
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = '';
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) numeric += ch;
    else if (code >= 65 && code <= 90) numeric += (code - 55).toString();
    else return null;
  }

  // mod 97 using chunked string math (JS Number cannot hold 20+ digits safely)
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    const chunk = remainder.toString() + numeric.slice(i, i + 7);
    remainder = Number(chunk) % 97;
  }
  if (remainder !== 1) return null;

  return {
    iban,
    countryCode,
    checkDigits: iban.slice(2, 4),
    bban: iban.slice(4),
  };
}

export function detectBankName(iban: string): string | undefined {
  const normalized = validateIban(iban);
  if (!normalized) return undefined;
  if (normalized.countryCode === 'SI') {
    const bankCode = normalized.bban.slice(0, 2);
    return SI_BANK_CODES[bankCode];
  }
  return undefined;
}

/**
 * Scans arbitrary text (e.g. statement header) for the first valid IBAN.
 * Handles spaced-group formatting ("SI56 0201 0001 2345 678").
 *
 * The inner regex is intentionally greedy to capture the full IBAN even when
 * groups are space-separated. After matching, we truncate the raw candidate to
 * the country-specific expected length before validating — this prevents the
 * greedy quantifier from consuming trailing letters (e.g. "ZA OBDOBJE...") that
 * immediately follow the IBAN in Slovenian bank statement headers.
 */
export function findIbanInText(text: string): string | null {
  const candidates = text.match(/[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,31}/gi);
  if (!candidates) return null;
  for (const raw of candidates) {
    const stripped = raw.replace(/[\s-]/g, '').toUpperCase();
    const countryCode = stripped.slice(0, 2);
    const expectedLen = IBAN_LENGTHS[countryCode];
    if (!expectedLen || stripped.length < expectedLen) continue;
    // Truncate to the exact expected length — the greedy match may have consumed
    // extra alphanumeric chars from surrounding text.
    const normalized = validateIban(stripped.slice(0, expectedLen));
    if (normalized) return normalized.iban;
  }
  return null;
}

/**
 * Extracts the 6-char suffixes embedded inside redacted-IBAN placeholders,
 * e.g. "[IBAN…898979]" → "898979". Used as a fallback for account matching
 * when full-IBAN detection fails locally — we compare each suffix against
 * the user's already-saved bank accounts.
 */
export function extractRedactedIbanSuffixes(redactedText: string): string[] {
  const out = new Set<string>();
  const re = /\[IBAN…([A-Z0-9]{6})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(redactedText)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}
