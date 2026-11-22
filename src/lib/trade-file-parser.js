import * as XLSX from 'xlsx';

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB maximum

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
 * - Scans all worksheets in the workbook in document order.
 * - Extracts valid trade data rows from every worksheet that contains headers and data.
 * - Concatenates rows across all valid worksheets into a single unified dataset.
 * - Preserves header separation, row numbering, and handles Unicode & quoted CSV without truncation.
 */
export function parseTradeFile({ fileName, fileSize, sourceBytes }) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || !sourceBytes?.byteLength || sourceBytes.byteLength !== fileSize) {
    throw new Error('The selected file is empty or its size is invalid.');
  }

  if (fileSize > MAX_FILE_SIZE_BYTES) {
    throw new Error(`The file size (${(fileSize / (1024 * 1024)).toFixed(1)} MB) exceeds the maximum allowed limit of 100 MB.`);
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
        if (rawDataRows.length === 0) {
          rawDataRows = sheetRows;
        } else {
          for (let r = 0; r < sheetRows.length; r++) {
            rawDataRows.push(sheetRows[r]);
          }
        }
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

  const columnSet = new Set();
  for (let i = 0; i < nonBlankRows.length; i++) {
    const row = nonBlankRows[i];
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const key of Object.keys(row)) {
        columnSet.add(key);
      }
    }
  }
  const columns = Array.from(columnSet);

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
