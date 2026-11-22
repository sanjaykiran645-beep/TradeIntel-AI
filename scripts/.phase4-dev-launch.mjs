import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.loadEnvFile('.env.local');
process.loadEnvFile('.env.vercel.local');
process.env.NODE_ENV = 'development';
process.env.DATASET_RETENTION_AUTOMATIC = 'false';
process.env.DATABASE_POOL_SIZE = '3';
process.env.DATABASE_CONNECTION_TIMEOUT = '30000';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PYTHON_EXECUTABLE = resolve(
  projectRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);
process.env.OBJECT_STORAGE_ENDPOINT ||= process.env.AWS_ENDPOINT_URL_S3 || '';
process.env.OBJECT_STORAGE_ACCESS_KEY ||= process.env.AWS_ACCESS_KEY_ID || '';
process.env.OBJECT_STORAGE_SECRET_KEY ||= process.env.AWS_SECRET_ACCESS_KEY || '';
process.env.OBJECT_STORAGE_REGION ||= process.env.AWS_REGION || 'auto';
process.env.OBJECT_STORAGE_BUCKET ||= 'uploads';

const child = spawn(process.execPath, ['scripts/vercel-dev.mjs', '--listen', '127.0.0.1:3000'], {
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', error => {
  console.error(`Could not start the existing local API server: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
