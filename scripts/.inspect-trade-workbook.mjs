import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import XLSX from 'xlsx';

const sourcePath = 'C:/Users/Admin/Downloads/61 ALL EXPORT TO WORLD FEB 26.xlsx';
const workbook = XLSX.readFile(sourcePath, {
  cellDates: true,
  cellNF: false,
  cellText: false,
});
const worksheetName = workbook.SheetNames?.[0];
if (!worksheetName) throw new Error('The source workbook has no worksheet.');
const worksheet = workbook.Sheets[worksheetName];
const rows = XLSX.utils.sheet_to_json(worksheet, {
  defval: '',
  raw: false,
  blankrows: true,
});
const headers = Object.keys(rows[0] || {});
const fields = [
  'Exporter_Name', 'Item_Description', 'COUNTRY', 'Consignee Name',
  'Quantity', 'Total FOB Value in INR', 'Currency', 'Period', 'Month',
];
const populated = Object.fromEntries(fields.map(field => [field, 0]));
const unique = Object.fromEntries(fields.map(field => [field, new Set()]));
let blankRows = 0;
let quantitySum = 0;
let valueSum = 0;

function numeric(value) {
  const cleaned = String(value ?? '').replace(/,/g, '').replace(/[^\d.-]/g, '');
  const result = Number(cleaned);
  return Number.isFinite(result) ? result : 0;
}

for (const row of rows) {
  if (Object.values(row).every(value => value === '' || value === null || value === undefined)) blankRows += 1;
  for (const field of fields) {
    const value = String(row[field] ?? '').trim();
    if (value) {
      populated[field] += 1;
      unique[field].add(value.toLowerCase());
    }
  }
  quantitySum += numeric(row.Quantity);
  valueSum += numeric(row['Total FOB Value in INR']);
}

const hash = createHash('sha256');
const input = createReadStream(sourcePath);
for await (const chunk of input) hash.update(chunk);

console.log(JSON.stringify({
  worksheet: worksheetName,
  usedRange: worksheet['!ref'] || null,
  parsedDataRows: rows.length,
  expectedRowsMatch: rows.length === 148015,
  blankRows,
  headerCount: headers.length,
  headers,
  populatedCounts: populated,
  distinctCounts: Object.fromEntries(fields.map(field => [field, unique[field].size])),
  quantitySum,
  totalFobInrSum: valueSum,
  sourceHash: hash.digest('hex'),
}));
