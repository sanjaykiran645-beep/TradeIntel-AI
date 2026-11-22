import assert from 'node:assert/strict';
import { getSupportedImportFileType, normalizeRow } from '../api/_routes/datasets.js';
import {
  completeObservedTotal,
  commercialRelevanceFactor,
  parseOptionalTradeNumber
} from '../api/_trade-evidence.js';

const timestamp = '2026-10-19T00:00:00.000Z';
assert.equal(getSupportedImportFileType('records.CSV'), 'csv');
assert.equal(getSupportedImportFileType('records.xls'), 'xls');
assert.equal(getSupportedImportFileType('records.xlsx'), 'xlsx');
assert.equal(getSupportedImportFileType('records.json'), 'json');
assert.equal(getSupportedImportFileType('records.pdf'), null);
assert.equal(getSupportedImportFileType('records'), null);
const missingMeasurements = normalizeRow({ company_name: 'Synthetic Importer', product_name: 'Synthetic Widget' }, 1, timestamp);
assert.equal(missingMeasurements.isValid, true);
assert.equal(missingMeasurements.normalizedRecord.quantity, null);
assert.equal(missingMeasurements.normalizedRecord.value_amount, null);
assert.equal(missingMeasurements.normalizedRecord.currency, null);
assert.equal(missingMeasurements.normalizedRecord.unit, null);
const sameSourceRow = normalizeRow({ company_name: 'Synthetic Importer', product_name: 'Synthetic Widget' }, 4, timestamp);
assert.equal(sameSourceRow.rawRecord.raw_hash, missingMeasurements.rawRecord.raw_hash);

const explicitZero = normalizeRow({
  company_name: 'Synthetic Importer',
  product_name: 'Synthetic Widget',
  Quantity: '0',
  Value: '0',
  Currency: 'INR',
  Unit: 'kg'
}, 2, timestamp);
assert.equal(explicitZero.normalizedRecord.quantity, 0);
assert.equal(explicitZero.normalizedRecord.value_amount, 0);

const namedInrValue = normalizeRow({
  company_name: 'Synthetic Importer',
  product_name: 'Synthetic Widget',
  'Total FOB Value in INR': '1,250.50'
}, 3, timestamp);
assert.equal(namedInrValue.normalizedRecord.value_amount, 1250.5);
assert.equal(namedInrValue.normalizedRecord.currency, 'INR');

assert.equal(parseOptionalTradeNumber('N/A'), null);
assert.equal(parseOptionalTradeNumber(''), null);
assert.equal(parseOptionalTradeNumber('1,250.50'), 1250.5);
assert.equal(completeObservedTotal({
  rowCount: 2,
  observedCount: 1,
  total: 1250,
  classifications: new Set(['INR']),
  requiredClassification: 'INR'
}), null);
assert.equal(completeObservedTotal({
  rowCount: 2,
  observedCount: 2,
  total: 1250,
  classifications: new Set(['INR', 'USD']),
  requiredClassification: 'INR'
}), null);
assert.equal(completeObservedTotal({
  rowCount: 1,
  observedCount: 1,
  total: 0,
  classifications: new Set(['INR']),
  requiredClassification: 'INR'
}), 0);

assert.equal(commercialRelevanceFactor(2, null).status, 'UNAVAILABLE');
assert.equal(commercialRelevanceFactor(2, null).value, null);
assert.equal(commercialRelevanceFactor(2, 0).status, 'AVAILABLE');
assert.equal(commercialRelevanceFactor(2, 0).value, 0);
assert.equal(commercialRelevanceFactor(2, 25000).value, 10);

console.log('Synthetic trade import and evidence-scoring checks passed.');
