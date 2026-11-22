import pg from 'pg';
import { assertDatabaseTargetConsistency } from './_database-target.js';

const { Pool, types } = pg;
const connectionString = String(process.env.DATABASE_URL || '').trim();
const integerParser = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
};

// Keep the existing JSON API behavior for BIGINT identifiers while avoiding
// precision loss if a future identifier exceeds JavaScript's safe range.
types.setTypeParser(20, integerParser);
types.setTypeParser(1700, value => Number(value));

const TABLES = new Set([
  'datasets', 'raw_records', 'normalized_records', 'companies', 'products',
  'markets', 'company_potential', 'leads', 'contacts', 'web_research',
  'outreach_emails', 'inbox_messages', 'follow_up_queue', 'agent_runs',
  'audit_logs', 'crm_activities', 'response_drafts', 'system_settings'
]);
const TABLES_WITH_DATASET = new Set([
  'raw_records', 'normalized_records', 'companies', 'products', 'markets',
  'company_potential', 'leads', 'contacts', 'web_research', 'outreach_emails',
  'inbox_messages', 'follow_up_queue', 'agent_runs', 'crm_activities', 'response_drafts'
]);
const JSONB_COLUMNS = Object.freeze({
  datasets: new Set(['column_mapping', 'detected_entities']),
  raw_records: new Set(['raw_data', 'errors']),
  products: new Set(['growth_trend']),
  markets: new Set(['market_gaps']),
  company_potential: new Set(['evidence_breakdown']),
  agent_runs: new Set(['stage_state', 'result', 'error']),
  leads: new Set(['evidence']),
  outreach_emails: new Set(['personalization_evidence', 'validation_errors']),
  inbox_messages: new Set(['extracted_entities']),
  response_drafts: new Set(['review_reasons']),
  crm_activities: new Set(['metadata']),
  audit_logs: new Set(['details']),
  system_settings: new Set(['value']),
  web_research: new Set(['result'])
});
const RELATIONS = Object.freeze({
  contacts: { companies: ['company_id', 'companies'] },
  leads: { companies: ['company_id', 'companies'], contacts: ['contact_id', 'contacts'] },
  company_potential: { companies: ['company_id', 'companies'] },
  outreach_emails: { companies: ['company_id', 'companies'], contacts: ['contact_id', 'contacts'] },
  follow_up_queue: {
    outreach_emails: ['outreach_id', 'outreach_emails'],
    companies: ['company_id', 'companies'],
    contacts: ['contact_id', 'contacts']
  },
  inbox_messages: { companies: ['company_id', 'companies'], contacts: ['contact_id', 'contacts'] },
  response_drafts: { inbox_messages: ['inbox_message_id', 'inbox_messages'] }
});

const TRANSIENT_CODES = new Set(['08000', '08003', '08006', '57P01', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT']);
const SCHEMA_CODES = new Set(['42P01', '42703', '42804', '42883', '23503']);
const poolSize = Math.max(1, Math.min(10, Number.parseInt(process.env.DATABASE_POOL_SIZE || '3', 10) || 3));
const connectionTimeout = Math.max(1000, Math.min(30000, Number.parseInt(process.env.DATABASE_CONNECTION_TIMEOUT || '10000', 10) || 10000));
const queryTimeout = Math.max(1000, Math.min(120000, Number.parseInt(process.env.DATABASE_QUERY_TIMEOUT || '30000', 10) || 30000));

export const dbConfigured = Boolean(connectionString);

let pool = null;
const configuredClients = new WeakSet();

function databaseError(error) {
  const sourceCode = String(error?.code || '').toUpperCase();
  const normalized = new Error(error?.message || 'PostgreSQL request failed.');
  if (sourceCode === '57014' || sourceCode === 'QUERY_TIMEOUT' || /statement timeout|query read timeout/i.test(normalized.message)) {
    normalized.code = 'DATABASE_TIMEOUT';
    normalized.status = 504;
  } else if (TRANSIENT_CODES.has(sourceCode) || /^08/.test(sourceCode) || /^57P/.test(sourceCode)) {
    normalized.code = 'DATABASE_UNAVAILABLE';
    normalized.status = 503;
  } else if (SCHEMA_CODES.has(sourceCode)) {
    normalized.code = 'DATABASE_SCHEMA_ERROR';
    normalized.status = 500;
  } else {
    normalized.code = sourceCode || 'DATABASE_ERROR';
    normalized.status = Number(error?.status) || 500;
  }
  if (error?.detail) normalized.details = error.detail;
  if (error?.hint) normalized.hint = error.hint;
  return normalized;
}

function getPool() {
  if (!connectionString) {
    const error = new Error('Managed PostgreSQL is not configured. Set DATABASE_URL.');
    error.code = 'DATABASE_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  if (!pool) {
    assertDatabaseTargetConsistency({ ...process.env, DATABASE_URL: connectionString });
    pool = new Pool({
      connectionString,
      max: poolSize,
      connectionTimeoutMillis: connectionTimeout,
      idleTimeoutMillis: Math.max(1000, Math.min(30000, Number.parseInt(process.env.DATABASE_IDLE_TIMEOUT || '5000', 10) || 5000)),
      query_timeout: queryTimeout,
      allowExitOnIdle: true
    });
    pool.on('error', error => {
      // Never print connection strings or query values.
      console.error(`[DATABASE] idle client error code=${databaseError(error).code}`);
    });
  }
  return pool;
}

async function configureClient(client) {
  if (configuredClients.has(client)) return;
  await client.query({
    text: "SELECT set_config('statement_timeout', $1, false), set_config('idle_in_transaction_session_timeout', $2, false)",
    values: [String(queryTimeout), String(queryTimeout)],
    query_timeout: queryTimeout
  });
  configuredClients.add(client);
}

async function query(text, values = []) {
  const client = await getPool().connect();
  try {
    await configureClient(client);
    return await client.query({ text, values, query_timeout: queryTimeout });
  } finally {
    client.release();
  }
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(value))) {
    const error = new Error('Invalid database identifier.');
    error.code = 'DATABASE_SCHEMA_ERROR';
    throw error;
  }
  return `"${value}"`;
}

function splitTopLevel(source) {
  const result = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) throw Object.assign(new Error('Invalid select projection.'), { code: 'DATABASE_SCHEMA_ERROR' });
  }
  if (depth !== 0) throw Object.assign(new Error('Invalid select projection.'), { code: 'DATABASE_SCHEMA_ERROR' });
  if (source.slice(start).trim()) result.push(source.slice(start).trim());
  return result;
}

function parseProjection(specification) {
  if (!specification) return { fields: ['*'], relations: [] };
  const fields = [];
  const relations = [];
  for (const item of splitTopLevel(String(specification))) {
    const embedded = /^([a-z_][a-z0-9_]*)\((.*)\)$/i.exec(item);
    if (embedded) {
      relations.push({ table: embedded[1], projection: parseProjection(embedded[2]) });
    } else {
      fields.push(item);
    }
  }
  return { fields: fields.length ? fields : [], relations };
}

function jsonPathExpression(column, tableAlias = 'root') {
  const raw = String(column);
  const match = /^([a-z_][a-z0-9_]*)(?:->>?[a-z_][a-z0-9_]*)+$/i.exec(raw);
  if (!match) return `${tableAlias}.${quoteIdentifier(raw)}`;
  const base = `${tableAlias}.${quoteIdentifier(raw.split(/->>?/)[0])}`;
  const parts = [...raw.matchAll(/->>?([a-z_][a-z0-9_]*)/gi)].map(part => part[1]);
  return `(${base} #>> '{${parts.join(',')}}')`;
}

export class QueryBuilder {
  constructor(table) {
    if (!TABLES.has(table)) throw Object.assign(new Error(`Unknown database table: ${table}`), { code: 'DATABASE_SCHEMA_ERROR' });
    this.table = table;
    this.action = 'select';
    this.values = [];
    this.projection = { fields: ['*'], relations: [] };
    this.filters = [];
    this.orders = [];
    this.pageStart = null;
    this.pageEnd = null;
    this.limitValue = null;
    this.countMode = null;
    this.head = false;
    this.singleMode = null;
    this.retryTransientReads = true;
    this.conflictColumns = [];
  }

  select(columns = '*', options = {}) {
    this.projection = parseProjection(columns);
    if (options?.count) this.countMode = options.count;
    if (options?.head) this.head = true;
    return this;
  }

  insert(rows) { this.action = 'insert'; this.values = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows, options = {}) {
    this.action = 'upsert';
    this.values = Array.isArray(rows) ? rows : [rows];
    this.conflictColumns = String(options.onConflict || 'id').split(',').map(value => value.trim()).filter(Boolean);
    return this;
  }
  update(values) { this.action = 'update'; this.values = values; return this; }
  delete() { this.action = 'delete'; return this; }
  eq(column, value) { return this.addFilter(column, 'eq', value); }
  neq(column, value) { return this.addFilter(column, 'neq', value); }
  gte(column, value) { return this.addFilter(column, 'gte', value); }
  lte(column, value) { return this.addFilter(column, 'lte', value); }
  in(column, values) { return this.addFilter(column, 'in', values); }
  is(column, value) { return this.addFilter(column, 'is', value); }
  not(column, operator, value) { return this.addFilter(column, `not_${operator}`, value); }
  filter(column, operator, value) { return this.addFilter(column, operator, value); }
  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(value) { this.limitValue = Math.max(0, Number(value) || 0); return this; }
  range(from, to) {
    this.pageStart = Math.max(0, Number(from) || 0);
    this.pageEnd = Math.max(this.pageStart, Number(to) || 0);
    return this;
  }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybeSingle'; return this; }
  singleAttempt() { this.retryTransientReads = false; return this; }

  addFilter(column, operator, value) {
    this.filters.push({ column: String(column), operator: String(operator).toLowerCase(), value });
    return this;
  }

  async then(resolve, reject) {
    const result = await this.execute();
    return Promise.resolve(result).then(resolve, reject);
  }

  async execute() {
    try {
      const built = this.buildQuery();
      let result = { rows: [], rowCount: 0 };
      if (!(this.head && built.countText)) {
        try {
          result = await query(built.text, built.values);
        } catch (error) {
          const mapped = databaseError(error);
          // Only retry idempotent reads, once, on a transient connection failure.
          if (this.action === 'select' && this.retryTransientReads && mapped.code === 'DATABASE_UNAVAILABLE') {
            await new Promise(resolveDelay => setTimeout(resolveDelay, 100 + Math.floor(Math.random() * 150)));
            result = await query(built.text, built.values);
          } else {
            throw mapped;
          }
        }
      }
      let rows = result.rows || [];
      rows = rows.map(row => {
        const hydrated = { ...row };
        for (const relation of this.projection.relations) {
          const key = `__embed_${relation.table}`;
          if (Object.hasOwn(hydrated, key)) {
            hydrated[relation.table] = hydrated[key];
            delete hydrated[key];
          }
        }
        if (this.action !== 'select' && this.projection.fields.length && !this.projection.fields.includes('*')) {
          for (const column of Object.keys(hydrated)) {
            if (!this.projection.fields.includes(column) && !this.projection.relations.some(relation => relation.table === column)) delete hydrated[column];
          }
        }
        return hydrated;
      });
      const count = built.countText
        ? Number((await query(built.countText, built.countValues)).rows[0]?.count || 0)
        : this.countMode === 'exact' && this.action !== 'select' ? Number(result.rowCount || 0) : null;
      if (this.head) rows = [];
      let data = rows;
      if (this.singleMode) {
        if (rows.length > 1 || (this.singleMode === 'single' && rows.length !== 1)) {
          const error = new Error(rows.length > 1 ? 'Expected one database row but multiple rows were returned.' : 'Expected one database row but no row was returned.');
          error.code = 'PGRST116';
          error.status = 406;
          throw error;
        }
        data = rows[0] || null;
      }
      return { data, error: null, count, status: 200, statusText: 'OK' };
    } catch (error) {
      const mapped = databaseError(error);
      return { data: null, error: mapped, count: null, status: mapped.status || 500, statusText: mapped.code };
    }
  }

  buildQuery() {
    const values = [];
    const bind = value => { values.push(value); return `$${values.length}`; };
    const buildWhere = () => {
      const where = this.filters.map(({ column, operator, value }) => {
        const expression = jsonPathExpression(column);
        if (operator === 'in') {
          if (!Array.isArray(value) || value.length === 0) return 'FALSE';
          const placeholders = value.map(bind).join(', ');
          return `${expression} IN (${placeholders})`;
        }
        if (operator === 'is' || operator === 'not_is') {
          const not = operator.startsWith('not_');
          const actual = operator.replace(/^not_/, '');
          const nullValue = value === null || String(value).toLowerCase() === 'null';
          if (actual !== 'is' || !nullValue) throw Object.assign(new Error(`Unsupported database filter operator: ${operator}`), { code: 'DATABASE_SCHEMA_ERROR' });
          return `${expression} IS ${not ? 'NOT ' : ''}NULL`;
        }
        const operators = { eq: '=', neq: '<>', gte: '>=', lte: '<=' };
        if (operator.startsWith('not_')) {
          const base = operator.slice(4);
          if (base === 'is') return `${expression} IS NOT NULL`;
          throw Object.assign(new Error(`Unsupported negated database filter operator: ${operator}`), { code: 'DATABASE_SCHEMA_ERROR' });
        }
        if (!operators[operator]) throw Object.assign(new Error(`Unsupported database filter operator: ${operator}`), { code: 'DATABASE_SCHEMA_ERROR' });
        if (value === null) return `${expression} IS ${operator === 'neq' ? 'NOT ' : ''}NULL`;
        // updated_at is used as an optimistic-concurrency token that round-trips through a JavaScript
        // Date (millisecond precision), while PostgreSQL now() stores microseconds. Compare at
        // millisecond precision so a freshly inserted row's token still matches.
        if (operator === 'eq' && column === 'updated_at') {
          return `date_trunc('milliseconds', ${expression}) = ${bind(value)}::timestamptz`;
        }
        return `${expression} ${operators[operator]} ${bind(value)}`;
      });
      return where.length ? ` WHERE ${where.join(' AND ')}` : '';
    };
    const tableSql = quoteIdentifier(this.table);
    const projection = this.projection;
    const joins = [];
    const selection = [];
    const requestedFields = projection.fields.length ? projection.fields : [];
    for (const field of requestedFields) {
      if (field === '*') selection.push('root.*');
      else selection.push(`root.${quoteIdentifier(field)} AS ${quoteIdentifier(field)}`);
    }
    for (const relation of projection.relations) {
      const relSpec = RELATIONS[this.table]?.[relation.table];
      if (!relSpec || relSpec[1] !== relation.table) {
        throw Object.assign(new Error(`No verified ${this.table}.${relation.table} relationship is defined.`), { code: 'DATABASE_SCHEMA_ERROR' });
      }
      const [localColumn, targetTable] = relSpec;
      const alias = `embed_${relation.table}`;
      const joinConditions = [`root.${quoteIdentifier(localColumn)} = ${alias}."id"`];
      if (TABLES_WITH_DATASET.has(this.table) && TABLES_WITH_DATASET.has(targetTable)) {
        joinConditions.push(`root."dataset_id" IS NOT DISTINCT FROM ${alias}."dataset_id"`);
      }
      joins.push(`LEFT JOIN ${quoteIdentifier(targetTable)} ${alias} ON ${joinConditions.join(' AND ')}`);
      const relationFields = relation.projection.fields;
      if (!relationFields.length || relationFields.includes('*')) {
        selection.push(`to_jsonb(${alias}) AS ${quoteIdentifier(`__embed_${relation.table}`)}`);
      } else {
        const pairs = relationFields.flatMap(field => [
          `'${field.replace(/'/g, "''")}'`, `${alias}.${quoteIdentifier(field)}`
        ]);
        selection.push(`CASE WHEN ${alias}."id" IS NULL THEN NULL ELSE jsonb_build_object(${pairs.join(', ')}) END AS ${quoteIdentifier(`__embed_${relation.table}`)}`);
      }
    }
    const joinSql = joins.length ? ` ${joins.join(' ')}` : '';

    if (this.action === 'select') {
      const whereSql = buildWhere();
      const countValues = [...values];
      const orderSql = this.orders.length
        ? ` ORDER BY ${this.orders.map(({ column, ascending }) => `root.${quoteIdentifier(column)} ${ascending ? 'ASC' : 'DESC'}`).join(', ')}`
        : '';
      const start = this.pageStart ?? 0;
      const end = this.pageEnd;
      const limit = this.limitValue !== null ? this.limitValue : end !== null ? end - start + 1 : null;
      const limitSql = limit === null ? '' : ` LIMIT ${bind(limit)}`;
      const offsetSql = start > 0 ? ` OFFSET ${bind(start)}` : '';
      const countText = this.countMode === 'exact' ? `SELECT count(*)::bigint AS count FROM ${tableSql} root${whereSql}` : null;
      return {
        text: `SELECT ${selection.length ? selection.join(', ') : 'root.*'} FROM ${tableSql} root${joinSql}${whereSql}${orderSql}${limitSql}${offsetSql}`,
        values,
        countText,
        countValues
      };
    }

    if (this.action === 'insert' || this.action === 'upsert') {
      if (!this.values.length || this.values.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw Object.assign(new Error('Insert requires one or more object rows.'), { code: 'DATABASE_SCHEMA_ERROR' });
      }
      const columns = [...new Set(this.values.flatMap(row => Object.keys(row).filter(key => row[key] !== undefined)))];
      if (!columns.length) throw Object.assign(new Error('Insert has no writable columns.'), { code: 'DATABASE_SCHEMA_ERROR' });
      const columnSql = columns.map(quoteIdentifier).join(', ');
      const rowsSql = this.values.map(row => `(${columns.map(column => {
        const value = row[column] === undefined ? null : row[column];
        const serialized = JSONB_COLUMNS[this.table]?.has(column) && value !== null
          ? JSON.stringify(value)
          : value;
        return bind(serialized);
      }).join(', ')})`).join(', ');
      let conflictSql = '';
      if (this.action === 'upsert') {
        if (!this.conflictColumns.length) throw Object.assign(new Error('Upsert requires onConflict columns.'), { code: 'DATABASE_SCHEMA_ERROR' });
        const conflicts = this.conflictColumns.map(quoteIdentifier).join(', ');
        const updateColumns = columns.filter(column => !this.conflictColumns.includes(column));
        conflictSql = updateColumns.length
          ? ` ON CONFLICT (${conflicts}) DO UPDATE SET ${updateColumns.map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ')}`
          : ` ON CONFLICT (${conflicts}) DO NOTHING`;
      }
      const returning = this.projection.fields.length && !this.projection.fields.includes('*')
        ? this.projection.fields.map(field => `"${field}"`).join(', ')
        : '*';
      return { text: `INSERT INTO ${tableSql} (${columnSql}) VALUES ${rowsSql}${conflictSql} RETURNING ${returning}`, values, countText: null };
    }

    if (this.action === 'update') {
      const entries = Object.entries(this.values || {}).filter(([, value]) => value !== undefined);
      if (!entries.length) throw Object.assign(new Error('Update has no writable columns.'), { code: 'DATABASE_SCHEMA_ERROR' });
      const setSql = entries.map(([column, value]) => {
        const serialized = JSONB_COLUMNS[this.table]?.has(column) && value !== null
          ? JSON.stringify(value)
          : value;
        return `${quoteIdentifier(column)} = ${bind(serialized)}`;
      }).join(', ');
      const whereSql = buildWhere();
      return { text: `UPDATE ${tableSql} root SET ${setSql}${whereSql} RETURNING root.*`, values, countText: null };
    }

    if (this.action === 'delete') {
      if (!this.filters.length) throw Object.assign(new Error('Unfiltered deletes are disabled.'), { code: 'DATABASE_SCHEMA_ERROR' });
      const whereSql = buildWhere();
      return { text: `DELETE FROM ${tableSql} root${whereSql} RETURNING root.*`, values, countText: null };
    }
    throw Object.assign(new Error(`Unsupported database operation: ${this.action}`), { code: 'DATABASE_SCHEMA_ERROR' });
  }
}

const postgres = {
  from(table) { return new QueryBuilder(String(table)); },
  async query(text, values = []) {
    try {
      return await query(text, values);
    } catch (error) {
      throw databaseError(error);
    }
  },
  async healthcheck() {
    const result = await postgres.query('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  },
  async withTransaction(callback) {
    const client = await getPool().connect();
    try {
      await configureClient(client);
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original transaction error */ }
      throw databaseError(error);
    } finally {
      client.release();
    }
  },
  async withReadOnlyTransaction(callback) {
    const client = await getPool().connect();
    try {
      await configureClient(client);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original transaction error */ }
      throw databaseError(error);
    } finally {
      client.release();
    }
  },
  async close() {
    if (pool) {
      const activePool = pool;
      pool = null;
      await activePool.end();
    }
  }
};

export default postgres;
