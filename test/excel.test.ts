import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type * as SheetJSTypes from 'xlsx';
import { excelWorkbookToConfigs, sheetRowsToConfig } from '../src/excel.js';

const require = createRequire(import.meta.url);
const XLSX: typeof SheetJSTypes = require('xlsx');

test('Excel 首行作为字段名并保留单元格数据类型', () => {
  const date = new Date('2026-07-26T08:30:00.000Z');
  const sheet = sheetRowsToConfig('levels', [
    ['id', 'enabled', 'rate', 'opened_at'],
    [1, true, 1.25, date],
    [2, false, null, null]
  ]);

  assert.equal(sheet.name, 'levels');
  assert.deepEqual(sheet.headers, ['id', 'enabled', 'rate', 'opened_at']);
  assert.deepEqual(sheet.value, [
    { id: 1, enabled: true, rate: 1.25, opened_at: date.toISOString() },
    { id: 2, enabled: false, rate: null, opened_at: null }
  ]);
});

test('Excel 空表头和重复表头会生成稳定且唯一的 JSON 字段', () => {
  const sheet = sheetRowsToConfig('items', [
    [null, 'name', 'name'],
    [1001, '剑', 'sword'],
    [null, null, null],
    [1002, '盾', 'shield']
  ]);

  assert.deepEqual(sheet.headers, ['column_1', 'name', 'name_2']);
  assert.equal(sheet.row_count, 2);
  assert.deepEqual(sheet.value[1], { column_1: 1002, name: '盾', name_2: 'shield' });
});

test('SheetJS CE 同时解析 xls 与 xlsx，并读取公式的已保存结果', async () => {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['id', 'name', 'enabled', 'rate', 'double_id'],
    [1, '新手关', true, 1.25, null],
    [2, '森林关', false, 2.5, null]
  ]);
  worksheet.E2 = { t: 'n', v: 2, f: 'A2*2' };
  worksheet.E3 = { t: 'n', v: 4, f: 'A3*2' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'levels');

  for (const bookType of ['xls', 'xlsx'] as const) {
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType });
    const [sheet] = await excelWorkbookToConfigs(buffer);
    assert.equal(sheet?.name, 'levels');
    assert.deepEqual(sheet?.value[0], { id: 1, name: '新手关', enabled: true, rate: 1.25, double_id: 2 });
    assert.deepEqual(sheet?.value[1], { id: 2, name: '森林关', enabled: false, rate: 2.5, double_id: 4 });
  }
});
