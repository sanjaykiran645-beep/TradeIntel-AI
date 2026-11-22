import * as XLSX from 'xlsx';

const complexCsv = 'company_name,product_name\n"Unicode Café — ☕ and Résumé",Coffee\n';
const bytes = new TextEncoder().encode(complexCsv);
const wb1 = XLSX.read(bytes, { type: 'array', codepage: 65001 });
console.log('With codepage 65001:', XLSX.utils.sheet_to_json(wb1.Sheets[wb1.SheetNames[0]])[0]);

const text = new TextDecoder('utf-8').decode(bytes);
const wb2 = XLSX.read(text, { type: 'string' });
console.log('With type string:', XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]])[0]);
