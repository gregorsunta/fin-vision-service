import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { createLogger } from '../../utils/logger.js';
import { parseStatementCsv } from './csv-parser.js';
import type { ParsedStatement } from './types.js';

const log = createLogger('services.bank-statement.xlsx-parser');

/**
 * XLSX parsing reuses the CSV parser to avoid duplicating the header-mapping
 * heuristics. Approach: convert each sheet to CSV text, concatenate, then
 * defer to the CSV parser. If a workbook has multiple sheets we try the
 * sheet named "Transakcije"/"Transactions"/"Promet" first, otherwise the
 * first non-empty sheet.
 */
export async function parseStatementXlsx(buffer: Buffer): Promise<ParsedStatement> {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const preferredNames = ['transakcije', 'transactions', 'promet', 'prometi', 'izpisek'];

  const sheetNames = workbook.SheetNames;
  let chosenSheet: string | undefined;
  for (const name of preferredNames) {
    const match = sheetNames.find((s) => s.toLowerCase().includes(name));
    if (match) {
      chosenSheet = match;
      break;
    }
  }
  if (!chosenSheet) {
    chosenSheet = sheetNames.find((s) => {
      const ws = workbook.Sheets[s];
      return ws && Object.keys(ws).filter((k) => !k.startsWith('!')).length > 0;
    });
  }
  if (!chosenSheet) {
    throw new Error('XLSX has no non-empty sheets');
  }

  log.debug({ chosenSheet, allSheets: sheetNames }, 'selected xlsx sheet');

  const rows: unknown[][] = XLSX.utils.sheet_to_json(workbook.Sheets[chosenSheet], {
    header: 1,
    raw: false,
    defval: '',
  });

  const csvText = Papa.unparse(rows as string[][], { delimiter: ';' });
  const result = await parseStatementCsv({ buffer: Buffer.from(csvText, 'utf8') });
  return { ...result, parser: 'xlsx', extra: { ...result.extra, chosenSheet, allSheets: sheetNames } };
}
