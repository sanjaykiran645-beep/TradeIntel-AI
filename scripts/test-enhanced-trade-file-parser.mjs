import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

const bytes = value => new TextEncoder().encode(value).buffer;

const SUPPORTED_EXTENSIONS = new Set(['csv', 'xls', 'xlsx', 'json']);

const COMPANY_KEYS = [
  'Consignee Name', 'consignee_name', 'Importer Name', 'importer_name',
  'Importer', 'importer', 'Buyer Name', 'buyer_name', 'Buyer', 'buyer',
  'Company Name', 'company_name', 'Company', 'company'
];

const PRODUCT_KEYS = [
  'Item_Description', 'Item Description', 'item_description',
  'Product Description', 'product_description', 'Product Name', 'product_name',
  'Product', 'product', 'Commodity', 'commodity', 'Item', 'item'
];

function firstValue(row, keys) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    const val = row[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') return String(val).trim();
  }
  return '';
}

function isRowEmpty(row) {
  if (!row || typeof row !== 'object') return true;
  return Object.values(row).every(v => v === null || v === undefined || String(v).trim() === '');
}

/**
 * Multi-worksheet policy:
 * - Scans all worksheets in document order.
 * - Extracts valid trade data rows from every worksheet that contains headers and data.
 * - Concatenates rows across all valid worksheets into a single unified dataset.
 * - Preserves header separation, row numbering, and handles Unicode & quoted CSV.
 */
export function parseTradeFile({ fileName, fileSize, sourceBytes }) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || !sourceBytes?.byteLength || sourceBytes.byteLength !== fileSize) {
    throw new Error('The selected file is empty or its size is invalid.');
  }

  const extension = String(fileName || '').trim().split('.').pop()?.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error('Unsupported file type. Choose a CSV, XLS, XLSX, or JSON file.');
  }

  let rawDataRows = [];
  let sheetNamesProcessed = [];

  if (extension === 'json') {
    let json;
    try {
      json = JSON.parse(new TextDecoder('utf-8').decode(sourceBytes));
    } catch {
      throw new Error('Invalid JSON file.');
    }

    const items = Array.isArray(json)
      ? json
      : Array.isArray(json?.data)
        ? json.data
        : [json];
    rawDataRows = items.filter(item => item && typeof item === 'object' && !Array.isArray(item));
    sheetNamesProcessed = ['JSON'];
  } else if (extension === 'csv') {
    let workbook;
    try {
      const text = new TextDecoder('utf-8').decode(sourceBytes);
      workbook = XLSX.read(text, {
        type: 'string',
        cellDates: true,
        cellNF: false,
        cellText: false,
        raw: false
      });
    } catch {
      throw new Error('The file could not be parsed as CSV, XLS, or XLSX data.');
    }

    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) throw new Error('The file contains no worksheet.');
    const sheet = workbook.Sheets[sheetName];
    const sheetRows = XLSX.utils.sheet_to_json(sheet, {
      defval: '',
      raw: false,
      blankrows: false
    });
    rawDataRows = sheetRows;
    sheetNamesProcessed = [sheetName];
  } else {
    // XLS or XLSX: process ALL worksheets according to documented multi-worksheet policy
    let workbook;
    try {
      workbook = XLSX.read(sourceBytes, {
        type: 'array',
        cellDates: true,
        cellNF: false,
        cellText: false
      });
    } catch {
      throw new Error('The file could not be parsed as CSV, XLS, or XLSX data.');
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error('The file contains no worksheet.');
    }

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet || !sheet['!ref']) continue;
      const sheetRows = XLSX.utils.sheet_to_json(sheet, {
        defval: '',
        raw: false,
        blankrows: false
      });
      if (Array.isArray(sheetRows) && sheetRows.length > 0) {
        rawDataRows.push(...sheetRows);
        sheetNamesProcessed.push(sheetName);
      }
    }

    if (sheetNamesProcessed.length === 0) {
      throw new Error('The file contains no worksheet with data rows.');
    }
  }

  if (!Array.isArray(rawDataRows) || rawDataRows.length === 0) {
    throw new Error('No data rows were found in the file.');
  }

  // Filter out completely blank rows
  let emptyRowsCount = 0;
  const nonBlankRows = [];
  for (const row of rawDataRows) {
    if (isRowEmpty(row)) {
      emptyRowsCount++;
    } else {
      nonBlankRows.push(row);
    }
  }

  if (nonBlankRows.length === 0) {
    throw new Error('No data rows were found in the file.');
  }

  // Validate all records and collect metrics
  const validationErrors = [];
  const seenHashes = new Map();
  let validRowsCount = 0;
  let duplicateRowsCount = 0;
  let invalidRowsCount = 0;

  for (let idx = 0; idx < nonBlankRows.length; idx++) {
    const row = nonBlankRows[idx];
    const sourceRowNum = idx + 1; // 1-based source data row index
    const company = firstValue(row, COMPANY_KEYS);
    const product = firstValue(row, PRODUCT_KEYS);
    const errors = [];

    if (!company) errors.push('Missing company name');
    if (!product) errors.push('Missing product description');

    const rowHash = JSON.stringify(row);
    if (errors.length === 0) {
      if (seenHashes.has(rowHash)) {
        duplicateRowsCount++;
      } else {
        seenHashes.set(rowHash, sourceRowNum);
        validRowsCount++;
      }
    } else {
      invalidRowsCount++;
      validationErrors.push({
        sourceRowNumber: sourceRowNum,
        errors,
        row
      });
    }
  }

  const columns = [...new Set(
    nonBlankRows.flatMap(row => row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : [])
  )];

  return {
    rows: nonBlankRows,
    columns,
    totalSourceRows: rawDataRows.length,
    validRows: validRowsCount,
    duplicateRows: duplicateRowsCount,
    errorRows: invalidRowsCount,
    emptyRows: emptyRowsCount,
    validationErrors,
    sheetNames: sheetNamesProcessed,
    sheetCount: sheetNamesProcessed.length
  };
}

// RUN SELF TESTS
console.log('Testing enhanced parser...');

// Test 1: Basic CSV
const csv = parseTradeFile({
  fileName: 'trades.csv',
  fileSize: new TextEncoder().encode('company_name,product_name\nAcme,Widgets').byteLength,
  sourceBytes: bytes('company_name,product_name\nAcme,Widgets')
});
assert.deepEqual(csv.rows, [{ company_name: 'Acme', product_name: 'Widgets' }]);
assert.deepEqual(csv.columns, ['company_name', 'product_name']);
assert.equal(csv.validRows, 1);
assert.equal(csv.duplicateRows, 0);

// Test 2: Unicode & quoted CSV
const unicodeCsv = 'company_name,product_name,country\n"Café & Co. — ☕","Super, Widget",France\n';
const unicodeBytes = new TextEncoder().encode(unicodeCsv);
const uParsed = parseTradeFile({ fileName: 'u.csv', fileSize: unicodeBytes.byteLength, sourceBytes: unicodeBytes.buffer });
assert.equal(uParsed.rows[0].company_name, 'Café & Co. — ☕');
assert.equal(uParsed.rows[0].product_name, 'Super, Widget');

// Test 3: Multi-sheet XLSX
const wb = XLSX.utils.book_new();
const ws1 = XLSX.utils.aoa_to_sheet([
  ['company_name', 'product_name'],
  ['Acme 1', 'Widget 1']
]);
const ws2 = XLSX.utils.aoa_to_sheet([
  ['company_name', 'product_name'],
  ['Acme 2', 'Widget 2']
]);
XLSX.utils.book_append_sheet(wb, ws1, 'Sheet1');
XLSX.utils.book_append_sheet(wb, ws2, 'Sheet2');
const wbBytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
const multiParsed = parseTradeFile({ fileName: 'multi.xlsx', fileSize: wbBytes.byteLength, sourceBytes: wbBytes });
assert.equal(multiParsed.rows.length, 2);
assert.equal(multiParsed.sheetCount, 2);
assert.equal(multiParsed.rows[0].company_name, 'Acme 1');
assert.equal(multiParsed.rows[1].company_name, 'Acme 2');

// Test 4: 10,000 row CSV
const bigCsvLines = ['company_name,product_name,country,quantity,total_fob_value_in_inr,sbill_date'];
for (let i = 0; i < 10000; i++) {
  bigCsvLines.push(`"Company ${i}","Product ${i}","Country ${i % 5}",100,5000,2026-01-01`);
}
const bigCsvBytes = new TextEncoder().encode(bigCsvLines.join('\n')).buffer;
const bigParsed = parseTradeFile({ fileName: 'big.csv', fileSize: bigCsvBytes.byteLength, sourceBytes: bigCsvBytes });
assert.equal(bigParsed.rows.length, 10000);
assert.equal(bigParsed.validRows, 10000);

// Test 5: Validation error tracking
const invalidCsv = 'company_name,product_name\nAcme,Widget\n,MissingCompany\nAcme,\nAcme,Widget\n';
const invBytes = new TextEncoder().encode(invalidCsv).buffer;
const invParsed = parseTradeFile({ fileName: 'inv.csv', fileSize: invBytes.byteLength, sourceBytes: invBytes });
assert.equal(invParsed.validRows, 1);
assert.equal(invParsed.duplicateRows, 1);
assert.equal(invParsed.errorRows, 2);
assert.equal(invParsed.validationErrors.length, 2);
assert.equal(invParsed.validationErrors[0].sourceRowNumber, 2);
assert.deepEqual(invParsed.validationErrors[0].errors, ['Missing company name']);
assert.equal(invParsed.validationErrors[1].sourceRowNumber, 3);
assert.deepEqual(invParsed.validationErrors[1].errors, ['Missing product description']);

console.log('All enhanced parser tests PASSED!');
