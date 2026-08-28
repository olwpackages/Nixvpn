const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron');
const appPath = path.join(__dirname, '..');
const child = spawn(electron, ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', appPath, ...process.argv.slice(2)], { env: { ...process.env, GSETTINGS_BACKEND: 'memory' }, stdio: 'inherit' });

child.once('error', (error) => {
  console.error(`Could not start local Electron: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
