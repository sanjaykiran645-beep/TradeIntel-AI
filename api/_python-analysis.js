import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertDatabaseTargetConsistency } from './_database-target.js';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/_pandas_analysis.py', import.meta.url));
const WORKER_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.PYTHON_ANALYSIS_TIMEOUT_MS || '900000', 10) || 900000);

function pythonCommand() {
  const configured = String(process.env.PYTHON_EXECUTABLE || '').trim();
  if (configured) return configured;

  const executable = process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python');
  for (const environment of ['.venv', '.venv-1']) {
    const candidate = path.resolve(process.cwd(), environment, executable);
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function errorCodeFromWorker(message) {
  const match = String(message || '').match(/^(DATABASE_UNAVAILABLE|DATABASE_TIMEOUT|DATABASE_SCHEMA_ERROR):/);
  return match?.[1] || null;
}

export async function runPandasAnalysis(datasetId) {
  if (!datasetId) throw Object.assign(new Error('A dataset_id is required for Python analysis.'), { code: 'PYTHON_INPUT_INVALID' });
  assertDatabaseTargetConsistency();
  const command = pythonCommand();

  return await new Promise((resolve, reject) => {
    const child = spawn(command, [SCRIPT_PATH, String(datasetId)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finishReject(Object.assign(new Error('Python/Pandas analysis exceeded the configured worker timeout.'), { code: 'PYTHON_ANALYSIS_TIMEOUT' }));
    }, WORKER_TIMEOUT_MS);
    timeout.unref?.();

    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }

    function appendBounded(current, chunk) {
      const next = current + chunk;
      return next.length > 1024 * 1024 ? next.slice(-1024 * 1024) : next;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    child.on('error', error => {
      finishReject(Object.assign(new Error('Python runtime is unavailable or could not be started.'), {
        code: 'PYTHON_RUNTIME_UNAVAILABLE',
        cause: error
      }));
    });
    child.on('close', code => {
      if (settled) return;
      clearTimeout(timeout);
      if (code !== 0) {
        const workerMessage = stderr.trim();
        let workerPayload = null;
        try { workerPayload = JSON.parse(workerMessage); } catch { /* Python import/startup errors are plain text. */ }
        const payloadCode = String(workerPayload?.code || '').toUpperCase();
        const databaseCode = errorCodeFromWorker(workerMessage) ||
          (['DATABASE_UNAVAILABLE', 'DATABASE_TIMEOUT', 'DATABASE_SCHEMA_ERROR'].includes(payloadCode) ? payloadCode : null);
        const missingPandas = /No module named ['"]pandas['"]/.test(workerMessage);
        const missingPsycopg = /No module named ['"]psycopg['"]/.test(workerMessage);
        const missingDependency = missingPandas || missingPsycopg;
        const errorCode = databaseCode || (missingDependency
          ? (missingPandas ? 'PANDAS_NOT_INSTALLED' : 'PYTHON_POSTGRES_DRIVER_NOT_INSTALLED')
          : 'PYTHON_ANALYSIS_FAILED');
        const message = databaseCode === 'DATABASE_TIMEOUT'
          ? 'Python dataset page exceeded the configured database timeout.'
          : databaseCode === 'DATABASE_SCHEMA_ERROR'
            ? 'Python worker query does not match the configured database schema.'
            : databaseCode
              ? 'Python worker could not reach the configured database.'
          : missingPandas
            ? 'Python is available but Pandas is not installed.'
            : missingPsycopg
              ? 'Python is available but psycopg is not installed.'
              : 'Python analysis failed; inspect the worker error without exposing credentials.';
        finishReject(Object.assign(new Error(message), { code: errorCode }));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (Number(result.datasetId) !== Number(datasetId) || !Number.isInteger(result.recordsProcessed)) {
          throw new Error('Python output did not confirm the requested dataset and processed row count.');
        }
        settled = true;
        resolve(result);
      } catch (error) {
        finishReject(Object.assign(new Error('Python returned invalid or mismatched analysis JSON.'), {
          code: 'PYTHON_OUTPUT_INVALID',
          cause: error
        }));
      }
    });
  });
}

export async function analyzePersistedDatasetWithPandas(datasetId) {
  if (!datasetId) {
    return { status: 'REVIEW_REQUIRED', recordsProcessed: 0, reason: 'A dataset_id is required before Python analysis can run.' };
  }

  try {
    const analysis = await runPandasAnalysis(datasetId);
    if (analysis.datasetId !== Number(datasetId)) {
      return { status: 'FAILED', recordsProcessed: 0, reason: 'Python returned results for a different dataset.' };
    }
    return {
      status: 'COMPLETED',
      recordsProcessed: analysis.recordsProcessed,
      source: { table: 'normalized_records', datasetId: Number(datasetId), method: 'Python direct PostgreSQL keyset pagination' },
      analysis
    };
  } catch (error) {
    const blockedCodes = new Set([
      'PYTHON_RUNTIME_UNAVAILABLE',
      'PANDAS_NOT_INSTALLED',
      'PYTHON_POSTGRES_DRIVER_NOT_INSTALLED',
      'DATABASE_UNAVAILABLE',
      'DATABASE_TARGET_MISMATCH',
      'DATABASE_TARGET_UNVERIFIED',
      'DATABASE_TARGET_MISSING',
      'DATABASE_TIMEOUT',
      'DATABASE_SCHEMA_ERROR'
    ]);
    return {
      status: blockedCodes.has(error.code) ? 'BLOCKED' : 'FAILED',
      recordsProcessed: 0,
      source: { table: 'normalized_records', datasetId: Number(datasetId), method: 'Python direct PostgreSQL keyset pagination' },
      error: { code: error.code || 'PYTHON_ANALYSIS_FAILED', message: error.message },
      reason: error.message
    };
  }
}

export function pandasScriptPath() {
  return path.resolve(SCRIPT_PATH);
}
