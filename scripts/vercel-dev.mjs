import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

for (const envFile of ['.env.local', '.env.vercel.local']) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const server = spawn(cli, ['--yes', 'vercel', 'dev', ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

server.on('error', (error) => {
  console.error(`Unable to start Vercel Dev: ${error.message}`);
  process.exitCode = 1;
});

server.on('exit', (code) => {
  process.exitCode = code ?? 1;
});