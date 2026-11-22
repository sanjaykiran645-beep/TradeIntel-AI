import * as XLSX from 'xlsx';
import { parseTradeFile } from '../src/lib/trade-file-parser.js';

console.log('Testing 10,000 row CSV and XLSX parsing...');

// 1. CSV 10,000 rows
const csvLines = ['company_name,product_name,country,quantity,total_fob_value_in_inr,sbill_date'];
for (let i = 0; i < 10000; i++) {
  csvLines.push(`"Company, Inc. #${i}","Product ""Special"" ${i}","Country ${i % 5}",100,5000,2026-01-01`);
}
const csvBuffer = new TextEncoder().encode(csvLines.join('\n')).buffer;
const csvParsed = parseTradeFile({ fileName: 'test.csv', fileSize: csvBuffer.byteLength, sourceBytes: csvBuffer });
console.log('CSV 10k rows parsed:', csvParsed.rows.length);

// 2. XLSX 10,000 rows
const wb = XLSX.utils.book_new();
const data = [['company_name', 'product_name', 'country', 'quantity', 'total_fob_value_in_inr', 'sbill_date']];
for (let i = 0; i < 10000; i++) {
  data.push([`Company ${i}`, `Product ${i}`, `Country ${i % 5}`, 100, 5000, '2026-01-01']);
}
const ws = XLSX.utils.aoa_to_sheet(data);
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const xlsxArray = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
const xlsxParsed = parseTradeFile({ fileName: 'test.xlsx', fileSize: xlsxArray.byteLength, sourceBytes: xlsxArray });
console.log('XLSX 10k rows parsed:', xlsxParsed.rows.length);

// 3. Multi-sheet XLSX
const wbMulti = XLSX.utils.book_new();
const ws1 = XLSX.utils.aoa_to_sheet([
  ['company_name', 'product_name', 'country', 'quantity', 'total_fob_value_in_inr', 'sbill_date'],
  ['Company A', 'Product A', 'Country 1', 10, 100, '2026-01-01']
]);
const ws2 = XLSX.utils.aoa_to_sheet([
  ['company_name', 'product_name', 'country', 'quantity', 'total_fob_value_in_inr', 'sbill_date'],
  ['Company B', 'Product B', 'Country 2', 20, 200, '2026-01-02']
]);
XLSX.utils.book_append_sheet(wbMulti, ws1, 'CoverSheet');
XLSX.utils.book_append_sheet(wbMulti, ws2, 'DataSheet');
const multiArray = XLSX.write(wbMulti, { type: 'array', bookType: 'xlsx' });
const multiParsed = parseTradeFile({ fileName: 'multi.xlsx', fileSize: multiArray.byteLength, sourceBytes: multiArray });
console.log('Multi-sheet rows parsed:', multiParsed.rows.length);
