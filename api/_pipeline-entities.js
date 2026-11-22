import supabase from './_db-client.js';
import { countRawRecordsForDataset } from './_dataset-counts.js';
import { completeObservedTotal } from './_trade-evidence.js';

const PAGE_SIZE = 5000;
const WRITE_BATCH_SIZE = 1000;
const TOP_ITEMS = 10;

function chunks(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function normalizedName(value) {
  const text = String(value || '').trim();
  const ascii = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ascii || text.toLowerCase();
}

function increment(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function mostFrequent(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

function topNames(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_ITEMS)
    .map(([name]) => name);
}

async function readAll(table, columns, configure = query => query) {
  const rows = [];
  let offset = 0;

  while (true) {
    let query = supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    query = configure(query);

    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  return rows;
}

async function countDatasetRows(table, datasetId, filterName = null, filterValue = null) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId);
  if (filterName) query = query.eq(filterName, filterValue);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

async function getCompleteDatasetIds(targetDatasetId) {
  const { data: dataset, error: datasetError } = await supabase.from('datasets')
    .select('id,total_rows,valid_rows,error_rows,duplicate_rows,import_status,detected_entities')
    .eq('id', targetDatasetId)
    .maybeSingle();
  if (datasetError) throw datasetError;
  if (!dataset) throw Object.assign(new Error(`Dataset ${targetDatasetId} was not found.`), { code: 'DATASET_NOT_FOUND' });

  const [rawRows, normalizedRows, duplicateRows] = await Promise.all([
    countRawRecordsForDataset(targetDatasetId),
    countDatasetRows('normalized_records', targetDatasetId),
    countDatasetRows('raw_records', targetDatasetId, 'is_duplicate', true)
  ]);
  const expected = {
    totalRows: Number(dataset.total_rows || 0),
    validRows: Number(dataset.valid_rows || 0),
    duplicateRows: Number(dataset.duplicate_rows || 0),
    errorRows: Number(dataset.error_rows || 0)
  };
  const actual = { rawRows, normalizedRows, duplicateRows };
  const importStatus = dataset.import_status || dataset.detected_entities?.import?.status;
  const complete = importStatus === 'COMPLETED' &&
    rawRows === expected.totalRows &&
    expected.validRows + expected.duplicateRows + expected.errorRows === expected.totalRows &&
    duplicateRows === expected.duplicateRows &&
    normalizedRows === expected.validRows;
  if (!complete) {
    const error = new Error(`Dataset ${targetDatasetId} is not fully persisted; supervisor analysis cannot run.`);
    error.code = 'DATASET_COUNT_MISMATCH';
    error.details = { expected, actual };
    throw error;
  }

  // Entity aggregates are built from this dataset only. Do not merge companies,
  // products, markets, or activity across separate imported datasets.
  return { completeIds: [targetDatasetId], incomplete: [] };
}

function newAggregate(name) {
  return {
    nameCounts: new Map(),
    countryCounts: new Map(),
    products: new Map(),
    buyers: new Map(),
    markets: new Map(),
    quantity: 0,
    quantityObservations: 0,
    quantityUnits: new Set(),
    value: 0,
    valueObservations: 0,
    valueCurrencies: new Set(),
    transactions: 0,
    latestDate: null
  };
}

function addAggregate(aggregate, row) {
  const companyName = String(row.company_name || '').trim();
  const productName = String(row.product_name || '').trim();
  const country = String(row.country || '').trim();
  if (!companyName || !productName) return;

  increment(aggregate.nameCounts, companyName);
  if (country && !['unknown', 'global'].includes(country.toLowerCase())) increment(aggregate.countryCounts, country);
  increment(aggregate.products, productName);
  increment(aggregate.buyers, companyName);
  if (country) increment(aggregate.markets, country);
  if (row.quantity !== null && row.quantity !== undefined && row.unit && Number.isFinite(Number(row.quantity))) {
    aggregate.quantity += Number(row.quantity);
    aggregate.quantityObservations += 1;
    aggregate.quantityUnits.add(String(row.unit).trim().toUpperCase());
  }
  if (row.value_amount !== null && row.value_amount !== undefined && row.currency && Number.isFinite(Number(row.value_amount))) {
    aggregate.value += Number(row.value_amount);
    aggregate.valueObservations += 1;
    aggregate.valueCurrencies.add(String(row.currency).trim().toUpperCase());
  }
  aggregate.transactions += 1;

  if (row.transaction_date) {
    const date = new Date(row.transaction_date);
    if (!Number.isNaN(date.getTime()) && (!aggregate.latestDate || date > aggregate.latestDate)) {
      aggregate.latestDate = date;
    }
  }
}

function addProduct(product, row) {
  const name = String(row.product_name || '').trim();
  if (!name) return;
  const key = `${name.toLowerCase()}|${String(row.category || 'Trade').toLowerCase()}`;
  let aggregate = product.get(key);
  if (!aggregate) {
    aggregate = {
      nameCounts: new Map(),
      category: String(row.category || 'Trade'),
      markets: new Map(),
      buyers: new Map(),
      quantity: 0,
      quantityObservations: 0,
      quantityUnits: new Set(),
      value: 0,
      valueObservations: 0,
      valueCurrencies: new Set(),
      frequency: 0,
      latestDate: null
    };
    product.set(key, aggregate);
  }

  increment(aggregate.nameCounts, name);
  if (row.country && !['unknown', 'global'].includes(String(row.country).trim().toLowerCase())) increment(aggregate.markets, String(row.country).trim());
  if (row.company_name) increment(aggregate.buyers, String(row.company_name).trim());
  if (row.quantity !== null && row.quantity !== undefined && row.unit && Number.isFinite(Number(row.quantity))) {
    aggregate.quantity += Number(row.quantity);
    aggregate.quantityObservations += 1;
    aggregate.quantityUnits.add(String(row.unit).trim().toUpperCase());
  }
  if (row.value_amount !== null && row.value_amount !== undefined && row.currency && Number.isFinite(Number(row.value_amount))) {
    aggregate.value += Number(row.value_amount);
    aggregate.valueObservations += 1;
    aggregate.valueCurrencies.add(String(row.currency).trim().toUpperCase());
  }
  aggregate.frequency += 1;

  if (row.transaction_date) {
    const date = new Date(row.transaction_date);
    if (!Number.isNaN(date.getTime()) && (!aggregate.latestDate || date > aggregate.latestDate)) {
      aggregate.latestDate = date;
    }
  }
}

function addMarket(markets, row) {
  const country = String(row.country || '').trim();
  const productName = String(row.product_name || '').trim();
  if (!country || ['unknown', 'global'].includes(country.toLowerCase()) || !productName) return;
  const key = country.toLowerCase();
  let aggregate = markets.get(key);
  if (!aggregate) {
    aggregate = { countryCounts: new Map(), companies: new Set(), products: new Map(), volume: 0, rowCount: 0, valueObservations: 0, valueCurrencies: new Set() };
    markets.set(key, aggregate);
  }

  increment(aggregate.countryCounts, country);
  if (row.company_name) aggregate.companies.add(String(row.company_name).trim());
  increment(aggregate.products, productName);
  aggregate.rowCount += 1;
  if (row.value_amount !== null && row.value_amount !== undefined && row.currency && Number.isFinite(Number(row.value_amount))) {
    aggregate.volume += Number(row.value_amount);
    aggregate.valueObservations += 1;
    aggregate.valueCurrencies.add(String(row.currency).trim().toUpperCase());
  }
}

async function readExistingRows(table, columns, configure = query => query) {
  return readAll(table, columns, configure);
}

function uniqueMap(rows, keyFn, table) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (map.has(key)) {
      const error = new Error(`Duplicate entity keys exist in ${table}; refusing an ambiguous update.`);
      error.code = 'ENTITY_KEY_CONFLICT';
      throw error;
    }
    map.set(key, row);
  }
  return map;
}

async function upsertByPrimaryKey(table, rows, conflictColumns) {
  let written = 0;
  for (const batch of chunks(rows, WRITE_BATCH_SIZE)) {
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: conflictColumns, defaultToNull: false })
      .select('id');
    if (error) throw error;
    written += batch.length;
  }
  return written;
}

export async function materializeTradeEntities(targetDatasetId, { onlyMissingProducts = false } = {}) {
  const { completeIds, incomplete } = await getCompleteDatasetIds(targetDatasetId);
  const companyAggregates = new Map();
  const productAggregates = new Map();
  const marketAggregates = new Map();
  const targetCompanyKeys = new Set();

  for (const datasetId of completeIds) {
    const rows = await readAll(
      'normalized_records',
      'company_name,product_name,category,country,quantity,unit,value_amount,currency,transaction_date,role',
      query => query.eq('dataset_id', datasetId)
    );

    for (const row of rows) {
      const companyKey = normalizedName(row.company_name);
      if (!companyKey) continue;
      if (!onlyMissingProducts) {
        let company = companyAggregates.get(companyKey);
        if (!company) {
          company = newAggregate(row.company_name);
          companyAggregates.set(companyKey, company);
        }
        addAggregate(company, row);
        addMarket(marketAggregates, row);
        if (datasetId === targetDatasetId) targetCompanyKeys.add(companyKey);
      }
      addProduct(productAggregates, row);
    }
  }

  const datasetFilter = query => query.eq('dataset_id', targetDatasetId);
  const [existingCompanies, existingProducts, existingMarkets] = await Promise.all([
    onlyMissingProducts
      ? Promise.resolve([])
      : readExistingRows('companies', 'id,dataset_id,name,normalized_name,country,industry,primary_products,total_transactions,total_value,last_activity_date,roles,status,created_at', datasetFilter),
    readExistingRows('products', 'id,dataset_id,name,normalized_name,category,hs_code,total_demand_qty,total_demand_val,frequency,top_markets,top_buyers,top_suppliers,growth_trend,recency_date', datasetFilter),
    onlyMissingProducts
      ? Promise.resolve([])
      : readExistingRows('markets', 'id,dataset_id,country,normalized_country,region,active_companies_count,top_demanded_products,total_trade_volume,market_gaps', datasetFilter)
  ]);

  const companiesByKey = uniqueMap(existingCompanies, row => normalizedName(row.normalized_name || row.name), 'companies');
  const productsByKey = uniqueMap(existingProducts, row => `${String(row.normalized_name || row.name || '').trim().toLowerCase()}|${String(row.category || 'Trade').toLowerCase()}`, 'products');
  const marketsByKey = uniqueMap(existingMarkets, row => String(row.normalized_country || row.country || '').trim().toLowerCase(), 'markets');
  const now = new Date().toISOString();

  const companyRows = [...companyAggregates.entries()].map(([key, aggregate]) => {
    const existing = companiesByKey.get(key);
    const products = [...new Set([
      ...(existing?.primary_products || []),
      ...aggregate.products.keys()
    ])].sort((a, b) => a.localeCompare(b));
    const roles = [...new Set([...(existing?.roles || []), 'buyer'])];
    const row = {
      dataset_id: targetDatasetId,
      name: mostFrequent(aggregate.nameCounts) || aggregate.name,
      normalized_name: key,
      country: mostFrequent(aggregate.countryCounts) || existing?.country || null,
      industry: existing?.industry || 'Trade',
      primary_products: products,
      total_transactions: aggregate.transactions,
      total_value: completeObservedTotal({
        rowCount: aggregate.transactions,
        observedCount: aggregate.valueObservations,
        total: aggregate.value,
        classifications: aggregate.valueCurrencies,
        requiredClassification: 'INR'
      }),
      last_activity_date: aggregate.latestDate?.toISOString() || existing?.last_activity_date || null,
      roles,
      status: existing?.status || 'ACTIVE',
      created_at: existing?.created_at || now
    };
    if (existing?.id !== undefined) row.id = existing.id;
    return row;
  });

  const productRows = [...productAggregates.entries()].map(([key, aggregate]) => {
    const name = mostFrequent(aggregate.nameCounts) || key.split('|')[0];
    const existing = productsByKey.get(`${name.toLowerCase()}|${aggregate.category.toLowerCase()}`);
    const row = {
      dataset_id: targetDatasetId,
      name,
      normalized_name: name.toLowerCase().trim(),
      category: aggregate.category,
      hs_code: existing?.hs_code || null,
      total_demand_qty: completeObservedTotal({
        rowCount: aggregate.frequency,
        observedCount: aggregate.quantityObservations,
        total: aggregate.quantity,
        classifications: aggregate.quantityUnits
      }),
      total_demand_val: completeObservedTotal({
        rowCount: aggregate.frequency,
        observedCount: aggregate.valueObservations,
        total: aggregate.value,
        classifications: aggregate.valueCurrencies,
        requiredClassification: 'INR'
      }),
      frequency: aggregate.frequency,
      top_markets: topNames(aggregate.markets),
      top_buyers: topNames(aggregate.buyers),
      top_suppliers: existing?.top_suppliers || [],
      growth_trend: existing?.growth_trend || null,
      recency_date: aggregate.latestDate?.toISOString() || existing?.recency_date || null
    };
    if (existing?.id !== undefined) row.id = existing.id;
    return row;
  });

  const marketRows = [...marketAggregates.entries()].map(([key, aggregate]) => {
    const country = mostFrequent(aggregate.countryCounts) || key;
    const existing = marketsByKey.get(key);
    const row = {
      dataset_id: targetDatasetId,
      country,
      normalized_country: country.toLowerCase().trim(),
      region: existing?.region || null,
      active_companies_count: aggregate.companies.size,
      top_demanded_products: topNames(aggregate.products),
      total_trade_volume: completeObservedTotal({
        rowCount: aggregate.rowCount,
        observedCount: aggregate.valueObservations,
        total: aggregate.volume,
        classifications: aggregate.valueCurrencies,
        requiredClassification: 'INR'
      }),
      market_gaps: existing?.market_gaps || []
    };
    if (existing?.id !== undefined) row.id = existing.id;
    return row;
  });

  const [companiesWritten, productsWritten, marketsWritten] = await Promise.all([
    onlyMissingProducts ? Promise.resolve(0) : upsertByPrimaryKey('companies', companyRows, 'dataset_id,normalized_name'),
    upsertByPrimaryKey(
      'products',
      onlyMissingProducts
        ? productRows.filter(row => !productsByKey.has(`${row.normalized_name}|${row.category.toLowerCase()}`))
        : productRows,
      'dataset_id,normalized_name,category'
    ),
    onlyMissingProducts ? Promise.resolve(0) : upsertByPrimaryKey('markets', marketRows, 'dataset_id,normalized_country')
  ]);

  const companyIds = [];
  if (onlyMissingProducts) {
    const rows = await readAll('companies', 'id', datasetFilter);
    companyIds.push(...rows.map(company => company.id));
  } else {
    for (const batch of chunks([...targetCompanyKeys], 100)) {
      const { data, error } = await supabase
        .from('companies')
        .select('id,normalized_name')
        .eq('dataset_id', targetDatasetId)
        .in('normalized_name', batch);
      if (error) throw error;
      for (const company of data || []) companyIds.push(company.id);
    }
  }

  return {
    completeDatasetCount: completeIds.length,
    incompleteDatasetCount: incomplete.length,
    companies: companiesWritten,
    products: productsWritten,
    markets: marketsWritten,
    targetCompanyIds: [...new Set(companyIds)],
    coverage: {
      normalizedRoles: 'BUYER_RECORDS',
      exporterDetails: 'PRESERVED_IN_RAW_RECORDS',
      tradeClassification: 'PRESERVED_IN_RAW_RECORDS'
    }
  };
}
