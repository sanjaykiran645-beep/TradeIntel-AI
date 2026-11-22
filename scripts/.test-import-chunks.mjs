import XLSX from 'xlsx';

const sourcePath = 'C:/Users/Admin/Downloads/61 ALL EXPORT TO WORLD FEB 26.xlsx';
const workbook = XLSX.readFile(sourcePath, { cellDates: true, cellNF: false, cellText: false });
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const bounds = XLSX.utils.decode_range(sheet['!ref']);
const headerRows = XLSX.utils.sheet_to_json(sheet, {
  header: 1,
  defval: '',
  raw: false,
  blankrows: false,
  range: { s: { r: bounds.s.r, c: bounds.s.c }, e: { r: bounds.s.r, c: bounds.e.c } },
});
const headers = headerRows[0].map(value => String(value));
const firstChunk = XLSX.utils.sheet_to_json(sheet, {
  header: headers,
  defval: '',
  raw: false,
  blankrows: true,
  range: { s: { r: bounds.s.r + 1, c: bounds.s.c }, e: { r: bounds.s.r + 3, c: bounds.e.c } },
});
const lastChunk = XLSX.utils.sheet_to_json(sheet, {
  header: headers,
  defval: '',
  raw: false,
  blankrows: true,
  range: { s: { r: bounds.e.r, c: bounds.s.c }, e: { r: bounds.e.r, c: bounds.e.c } },
});
const required = ['Exporter_Name', 'Item_Description', 'COUNTRY', 'Consignee Name', 'Quantity', 'Total FOB Value in INR', 'Currency', 'Period', 'Month'];
console.log(JSON.stringify({
  worksheet: sheetName,
  sourceRowsFromRange: bounds.e.r - bounds.s.r,
  headerCount: headers.length,
  requiredHeadersPresent: required.every(name => headers.includes(name)),
  firstChunkRows: firstChunk.length,
  firstChunkKeysMatchHeader: firstChunk.every(row => headers.every(header => Object.hasOwn(row, header))),
  firstChunkExtraKeys: Object.keys(firstChunk[0] || {}).filter(key => !headers.includes(key)),
  lastChunkRows: lastChunk.length,
  firstAndLastRequiredFieldsPopulated: [...firstChunk.slice(0, 1), ...lastChunk].every(row => required.every(name => String(row[name] ?? '').trim() !== '')),
}));
