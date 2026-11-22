import { parse as parsePostgresConnectionString } from 'pg-connection-string';

const DATABASE_TARGET_SOURCES = Object.freeze([
  { key: 'DATABASE_URL', identityKey: 'DATABASE_URL_TARGET_ID' },
  { key: 'DATABASE_DIRECT_URL', identityKey: 'DATABASE_DIRECT_URL_TARGET_ID' },
  { key: 'PYTHON_DATABASE_URL', identityKey: 'PYTHON_DATABASE_URL_TARGET_ID' }
]);

// Preserve runtime precedence: Node uses DATABASE_URL; Python uses
// PYTHON_DATABASE_URL > DATABASE_DIRECT_URL > DATABASE_URL; migration and
// smoke scripts use DATABASE_DIRECT_URL > DATABASE_URL.

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeHost(value) {
  const host = nonEmpty(value);
  if (!host) return '';
  const withoutBrackets = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  if (withoutBrackets.includes(':')) {
    // WHATWG URL serialization canonicalizes equivalent IPv6 spellings.
    const normalized = new URL(`http://[${withoutBrackets}]/`).hostname;
    return normalized.slice(1, -1).toLowerCase();
  }
  return withoutBrackets.toLowerCase().replace(/\.$/, '');
}

function parseIdentity(value, env) {
  try {
    if (!/^postgres(?:ql)?:\/\//i.test(value)) return null;
    const uri = new URL(value);
    // pg-connection-string and libpq do not guarantee identical treatment of
    // percent-encoded reserved characters in a database path. Fail closed.
    if (/%[0-9a-f]{2}/i.test(uri.pathname.slice(1))) return null;
    const parsed = parsePostgresConnectionString(value);
    // These settings can route libpq/Python differently from node-postgres or
    // resolve an identity through external service configuration.
    if (parsed.hostaddr || parsed.dbname || parsed.service || nonEmpty(env.PGHOSTADDR) || nonEmpty(env.PGSERVICE)) return null;
    const host = nonEmpty(parsed.host) || nonEmpty(env.PGHOST);
    const portValue = nonEmpty(parsed.port) || nonEmpty(env.PGPORT) || '5432';
    const database = nonEmpty(parsed.database) || nonEmpty(env.PGDATABASE);
    const port = Number(portValue);
    if (!host || !database || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) return null;
    return { host: normalizedHost, port, database };
  } catch {
    // Parser errors can include connection text; callers receive only a status code.
    return null;
  }
}

export function selectedDatabaseTargetSources(env = process.env) {
  const configured = key => nonEmpty(env[key]) ? key : null;
  return {
    node: configured('DATABASE_URL'),
    python: configured('PYTHON_DATABASE_URL') || configured('DATABASE_DIRECT_URL') || configured('DATABASE_URL'),
    migration: configured('DATABASE_DIRECT_URL') || configured('DATABASE_URL')
  };
}

export function inspectDatabaseTargetConsistency(env = process.env) {
  const targets = DATABASE_TARGET_SOURCES
    .map(source => ({
      source: source.key,
      url: nonEmpty(env[source.key]),
      declaredId: nonEmpty(env[source.identityKey])
    }))
    .filter(target => target.url);

  if (!targets.length) return { status: 'MISSING' };

  for (const target of targets) {
    target.identity = parseIdentity(target.url, env);
    if (!target.identity) return { status: 'UNVERIFIED' };
  }

  const baseline = targets[0];
  for (const target of targets.slice(1)) {
    if (target.identity.database !== baseline.identity.database) return { status: 'MISMATCH' };
    if (target.declaredId && baseline.declaredId && target.declaredId !== baseline.declaredId) {
      return { status: 'MISMATCH' };
    }

    const sameAddress = target.identity.host === baseline.identity.host && target.identity.port === baseline.identity.port;
    if (sameAddress) continue;

    // Target IDs are configuration assertions, not independently verified
    // endpoint equivalence. Differing endpoints remain unverified.
    return { status: 'UNVERIFIED' };
  }

  return { status: 'MATCH' };
}

export function assertDatabaseTargetConsistency(env = process.env) {
  const result = inspectDatabaseTargetConsistency(env);
  if (result.status === 'MATCH') return result;

  const code = result.status === 'MISMATCH'
    ? 'DATABASE_TARGET_MISMATCH'
    : result.status === 'MISSING'
      ? 'DATABASE_TARGET_MISSING'
      : 'DATABASE_TARGET_UNVERIFIED';
  throw Object.assign(new Error('Database target configuration is missing, conflicting, or could not be verified.'), {
    code,
    status: 503
  });
}

