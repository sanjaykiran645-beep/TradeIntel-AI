import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseTradeFile } from '../src/lib/trade-file-parser.js';

const bytes = value => new TextEncoder().encode(value).buffer;

const csv = parseTradeFile({
  fileName: 'trades.csv',
  fileSize: new TextEncoder().encode('company_name,product_name\nAcme,Widgets').byteLength,
  sourceBytes: bytes('company_name,product_name\nAcme,Widgets')
});
assert.deepEqual(csv.rows, [{ company_name: 'Acme', product_name: 'Widgets' }]);
assert.deepEqual(csv.columns, ['company_name', 'product_name']);

const jsonBytes = bytes('[{"company_name":"Acme"}]');
const json = parseTradeFile({ fileName: 'trades.json', fileSize: jsonBytes.byteLength, sourceBytes: jsonBytes });
assert.equal(json.rows[0].company_name, 'Acme');

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ['company_name', 'product_name'], ['Acme', 'Widgets']
]), 'Trades');
const xlsxBytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
const xlsx = parseTradeFile({ fileName: 'trades.xlsx', fileSize: xlsxBytes.byteLength, sourceBytes: xlsxBytes });
assert.equal(xlsx.rows[0].product_name, 'Widgets');
const xlsBytes = XLSX.write(workbook, { type: 'array', bookType: 'biff8' });
const xls = parseTradeFile({ fileName: 'trades.xls', fileSize: xlsBytes.byteLength, sourceBytes: xlsBytes });
assert.equal(xls.rows[0].product_name, 'Widgets');

assert.throws(() => parseTradeFile({ fileName: 'trades.pdf', fileSize: 1, sourceBytes: bytes('x') }), /unsupported file type/i);
assert.throws(() => parseTradeFile({ fileName: 'trades.json', fileSize: 0, sourceBytes: new ArrayBuffer(0) }), /empty|size/i);
assert.throws(() => parseTradeFile({ fileName: 'trades.json', fileSize: 5, sourceBytes: bytes('{}') }), /size/i);
assert.throws(() => parseTradeFile({ fileName: 'trades.json', fileSize: 8, sourceBytes: bytes('{invalid') }), /invalid json/i);
assert.throws(() => parseTradeFile({ fileName: 'trades.json', fileSize: 2, sourceBytes: bytes('[]') }), /no data rows/i);
const malformedXlsxBytes = bytes('not-xlsx');
assert.throws(() => parseTradeFile({ fileName: 'trades.xlsx', fileSize: malformedXlsxBytes.byteLength, sourceBytes: malformedXlsxBytes }), /could not be parsed|worksheet|no data rows/i);

// Multi-sheet XLSX verification
const multiWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(multiWorkbook, XLSX.utils.aoa_to_sheet([
  ['company_name', 'product_name'], ['Sheet1 Buyer', 'Sheet1 Product']
]), 'Sheet1');
XLSX.utils.book_append_sheet(multiWorkbook, XLSX.utils.aoa_to_sheet([
  ['company_name', 'product_name'], ['Sheet2 Buyer', 'Sheet2 Product']
]), 'Sheet2');
const multiBytes = XLSX.write(multiWorkbook, { type: 'array', bookType: 'xlsx' });
const multiResult = parseTradeFile({ fileName: 'multi.xlsx', fileSize: multiBytes.byteLength, sourceBytes: multiBytes });
assert.equal(multiResult.rows.length, 2, 'Multi-sheet workbook must parse all sheets, not just the first');
assert.equal(multiResult.sheetCount, 2);
assert.equal(multiResult.rows[0].company_name, 'Sheet1 Buyer');
assert.equal(multiResult.rows[1].company_name, 'Sheet2 Buyer');

// Unicode & quoted CSV verification
const unicodeCsv = 'company_name,product_name\n"Acme Café & Co. — ☕","Special, Widget"\n';
const uBytes = new TextEncoder().encode(unicodeCsv);
const uResult = parseTradeFile({ fileName: 'unicode.csv', fileSize: uBytes.byteLength, sourceBytes: uBytes.buffer });
assert.equal(uResult.rows[0].company_name, 'Acme Café & Co. — ☕', 'Unicode characters must not be corrupted during CSV parsing');
assert.equal(uResult.rows[0].product_name, 'Special, Widget', 'Quoted commas must not split fields');

// Validation & error reporting with source row numbers
const invCsv = 'company_name,product_name\nAcme,Widget\n,MissingCompany\nAcme,\nAcme,Widget\n';
const invBytes = new TextEncoder().encode(invCsv).buffer;
const invResult = parseTradeFile({ fileName: 'inv.csv', fileSize: invBytes.byteLength, sourceBytes: invBytes });
assert.equal(invResult.validRows, 1);
assert.equal(invResult.duplicateRows, 1);
assert.equal(invResult.errorRows, 2);
assert.equal(invResult.validationErrors[0].sourceRowNumber, 2);
assert.deepEqual(invResult.validationErrors[0].errors, ['Missing company name']);
assert.equal(invResult.validationErrors[1].sourceRowNumber, 3);
assert.deepEqual(invResult.validationErrors[1].errors, ['Missing product description']);

// 100 MB file size limit verification
assert.throws(
  () => parseTradeFile({ fileName: 'large.csv', fileSize: 105 * 1024 * 1024, sourceBytes: new Uint8Array(105 * 1024 * 1024).buffer }),
  /exceeds the maximum allowed limit of 100 MB/i
);

// Large row count verification (>65,536 rows must not trigger Maximum call stack size exceeded)
const largeWorkbook = XLSX.utils.book_new();
const largeAoa = [['company_name', 'product_name']];
for (let i = 0; i < 70000; i++) {
  largeAoa.push([`Company ${i}`, `Product ${i}`]);
}
XLSX.utils.book_append_sheet(largeWorkbook, XLSX.utils.aoa_to_sheet(largeAoa), 'LargeSheet');
const largeXlsxBytes = XLSX.write(largeWorkbook, { type: 'array', bookType: 'xlsx' });
const largeResult = parseTradeFile({ fileName: 'large_70k.xlsx', fileSize: largeXlsxBytes.byteLength, sourceBytes: largeXlsxBytes });
assert.equal(largeResult.rows.length, 70000, 'All 70,000 rows must be parsed without call stack overflow');
assert.equal(largeResult.validRows, 70000);

console.log('Offline CSV, XLSX, and JSON parser fixtures passed; unsupported, empty, malformed, and mismatched files are rejected.');
