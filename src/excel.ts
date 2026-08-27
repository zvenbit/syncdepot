import { createRequire } from 'node:module';
import type * as SheetJSTypes from 'xlsx';

const require = createRequire(import.meta.url);
const XLSX: typeof SheetJSTypes = require('xlsx');

export const MAX_EXCEL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_EXCEL_ROWS = 10_000;
export const MAX_EXCEL_COLUMNS = 200;
export const MAX_EXCEL_JSON_BYTES = 750 * 1024;

export type ExcelConfigSheet = {
  name: string;
  headers: string[];
  row_count: number;
  column_count: number;
  value: Record<string, unknown>[];
};

type ExcelCell = string | number | boolean | Date | null | undefined;

const isBlankCell = (value: ExcelCell): boolean => value === null || value === undefined || value === '';

function jsonCellValue(value: ExcelCell): unknown {
  if (value instanceof Date) return value.toISOString();
  return isBlankCell(value) ? null : value;
}

function uniqueHeaders(row: readonly ExcelCell[], columnCount: number): string[] {
  const used = new Map<string, number>();
  return Array.from({ length: columnCount }, (_, index) => {
    const raw = row[index];
    const initial = isBlankCell(raw) ? `column_${index + 1}` : String(jsonCellValue(raw)).trim();
    const base = initial || `column_${index + 1}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export function sheetRowsToConfig(name: string, rows: readonly (readonly ExcelCell[])[]): ExcelConfigSheet {
  const headerIndex = rows.findIndex(row => row.some(value => !isBlankCell(value)));
  if (headerIndex < 0) throw new Error(`工作表“${name}”没有可读取的表头`);

  const tableRows = rows.slice(headerIndex);
  const columnCount = tableRows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  if (columnCount > MAX_EXCEL_COLUMNS) throw new Error(`工作表“${name}”最多支持 ${MAX_EXCEL_COLUMNS} 列`);

  const dataRows = tableRows.slice(1).filter(row => row.some(value => !isBlankCell(value)));
  if (dataRows.length > MAX_EXCEL_ROWS) throw new Error(`工作表“${name}”最多支持 ${MAX_EXCEL_ROWS} 行数据`);

  const headers = uniqueHeaders(tableRows[0]!, columnCount);
  const value = dataRows.map(row => Object.fromEntries(headers.map((header, index) => [header, jsonCellValue(row[index])])));
  return { name, headers, row_count: value.length, column_count: columnCount, value };
}

export async function excelWorkbookToConfigs(buffer: Buffer): Promise<ExcelConfigSheet[]> {
  if (!buffer.length) throw new Error('Excel 文件不能为空');
  if (buffer.length > MAX_EXCEL_FILE_BYTES) throw new Error(`Excel 文件不能超过 ${MAX_EXCEL_FILE_BYTES / 1024 / 1024} MB`);

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: true });
  const sheets = workbook.SheetNames.map(name => {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) throw new Error(`无法读取工作表“${name}”`);
    const rows = XLSX.utils.sheet_to_json<ExcelCell[]>(worksheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true
    });
    return sheetRowsToConfig(name, rows);
  });
  if (!sheets.length) throw new Error('Excel 文件中没有工作表');
  if (Buffer.byteLength(JSON.stringify(sheets), 'utf8') > MAX_EXCEL_JSON_BYTES) {
    throw new Error(`转换后的 JSON 不能超过 ${Math.floor(MAX_EXCEL_JSON_BYTES / 1024)} KB，请拆分工作表后重试`);
  }
  return sheets;
}
