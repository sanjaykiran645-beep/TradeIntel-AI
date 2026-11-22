import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import db from '../api/_db-client.js';

const sourcePath = 'C:/Users/Admin/Downloads/61 ALL EXPORT TO WORLD FEB 26.xlsx';
const hash = createHash('sha256');
for await (const chunk of createReadStream(sourcePath)) hash.update(chunk);
const sourceHash = hash.digest('hex');

try {
  const [size, datasets, raw, normalized, companies, products, markets, potential, leads, sourceMatch, dataset9] = await Promise.all([
    db.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
    db.query('SELECT id,status,import_status,analysis_status,total_rows,content_hash FROM datasets ORDER BY id'),
    db.query('SELECT count(*)::bigint AS count FROM raw_records'),
    db.query('SELECT count(*)::bigint AS count FROM normalized_records'),
    db.query('SELECT count(*)::bigint AS count FROM companies'),
    db.query('SELECT count(*)::bigint AS count FROM products'),
    db.query('SELECT count(*)::bigint AS count FROM markets'),
    db.query('SELECT count(*)::bigint AS count FROM company_potential'),
    db.query('SELECT count(*)::bigint AS count FROM leads'),
    db.query('SELECT count(*)::int AS count FROM datasets WHERE content_hash = $1', [sourceHash]),
    db.query('SELECT count(*)::int AS count FROM datasets WHERE id = 9'),
  ]);
  console.log(JSON.stringify({
    storageBytes: String(size.rows[0].bytes),
    datasetCount: datasets.rows.length,
    datasets: datasets.rows.map(({ id, status, import_status, analysis_status, total_rows, content_hash }) => ({
      id, status, import_status, analysis_status, total_rows, isSourceFile: content_hash === sourceHash,
    })),
    sourceHashMatches: Number(sourceMatch.rows[0].count),
    dataset9Exists: Number(dataset9.rows[0].count) === 1,
    rawRecords: String(raw.rows[0].count),
    normalizedRecords: String(normalized.rows[0].count),
    companies: String(companies.rows[0].count),
    products: String(products.rows[0].count),
    markets: String(markets.rows[0].count),
    companyPotential: String(potential.rows[0].count),
    leads: String(leads.rows[0].count),
  }));
} finally {
  await db.close();
}
