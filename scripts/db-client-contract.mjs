import assert from 'node:assert/strict';
import { QueryBuilder } from '../api/_db-client.js';

const page = new QueryBuilder('leads')
  .select('*, companies(name, country), contacts(name)', { count: 'exact' })
  .eq('dataset_id', 19)
  .filter('evidence->>source', 'eq', 'company_potential')
  .order('score', { ascending: false })
  .range(20, 39)
  .buildQuery();

assert.match(page.text, /LEFT JOIN "companies"/);
assert.match(page.text, /LEFT JOIN "contacts"/);
assert.match(page.text, /#>> '\{source\}'/);
assert.match(page.text, /LIMIT \$3 OFFSET \$4/);
assert.deepEqual(page.values, [19, 'company_potential', 20, 20]);
assert.deepEqual(page.countValues, [19, 'company_potential']);
assert.match(page.countText, /count\(\*\)/);

const update = new QueryBuilder('datasets')
  .update({ status: 'IMPORTED', updated_at: '2026-10-04T00:00:00.000Z' })
  .eq('id', 19)
  .filter('detected_entities->import->>status', 'eq', 'RUNNING')
  .buildQuery();
assert.deepEqual(update.values, ['IMPORTED', '2026-10-04T00:00:00.000Z', 19, 'RUNNING']);
assert.match(update.text, /SET "status" = \$1, "updated_at" = \$2 WHERE root\."id" = \$3 AND \(root\."detected_entities" #>> '\{import,status\}'\) = \$4/);

const datasetInsert = new QueryBuilder('datasets')
  .insert({ column_mapping: ['Exporter_Name', 'Item_Description'], detected_entities: { import: { status: 'RUNNING' } } })
  .buildQuery();
assert.deepEqual(datasetInsert.values, [
  '["Exporter_Name","Item_Description"]',
  '{"import":{"status":"RUNNING"}}'
]);

const rawRecordInsert = new QueryBuilder('raw_records')
  .insert({ raw_data: { Exporter_Name: 'Example Exporter' }, errors: [] })
  .buildQuery();
assert.deepEqual(rawRecordInsert.values, ['{"Exporter_Name":"Example Exporter"}', '[]']);

const compactUpsert = new QueryBuilder('products')
  .upsert([{ dataset_id: 19, normalized_name: 'widget', category: 'Trade' }], {
    onConflict: 'dataset_id,normalized_name,category'
  })
  .select('id')
  .buildQuery();
assert.match(compactUpsert.text, /RETURNING "id"$/);

const emptyIn = new QueryBuilder('leads').select('id').in('company_id', []).buildQuery();
assert.match(emptyIn.text, /WHERE FALSE/);

// Optimistic-concurrency token: updated_at round-trips through a millisecond-precision JavaScript Date,
// so equality must be evaluated at millisecond precision (PostgreSQL now() stores microseconds).
const casUpdate = new QueryBuilder('datasets')
  .update({ status: 'IMPORTED', updated_at: '2026-10-04T00:00:01.000Z' })
  .eq('id', 19)
  .eq('updated_at', '2026-10-04T00:00:00.000Z')
  .buildQuery();
assert.match(casUpdate.text, /date_trunc\('milliseconds', root\."updated_at"\) = \$4::timestamptz/);
assert.deepEqual(casUpdate.values, ['IMPORTED', '2026-10-04T00:00:01.000Z', 19, '2026-10-04T00:00:00.000Z']);
const casNull = new QueryBuilder('datasets').update({ status: 'X' }).eq('id', 1).is('updated_at', null).buildQuery();
assert.match(casNull.text, /root\."updated_at" IS NULL/);

assert.throws(() => new QueryBuilder('datasets').delete().buildQuery(), /Unfiltered deletes are disabled/);
assert.throws(() => new QueryBuilder('not_a_real_table'), /Unknown database table/);
assert.throws(() => new QueryBuilder('datasets').select('id').eq('id;DROP TABLE datasets', 1).buildQuery(), /Invalid database identifier/);

console.log('PostgreSQL query-contract checks passed.');
