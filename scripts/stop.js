#!/usr/bin/env node
// Stop the RSS reader started with `npm start` (or `node server.js`).
// Uses the PID file the server writes on boot: data/server-<PORT>.pid

import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.PORT) || 4173;
const root = process.cwd();
const pidFile = path.join(root, 'data', `server-${port}.pid`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPid() {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Make sure we only signal a node process running this server. */
function looksLikeServer(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return /node/.test(cmd) && /server\.js/.test(cmd);
  } catch {
    // /proc is not available (macOS/Windows): trust the PID file.
    return true;
  }
}

async function main() {
  const pid = readPid();

  if (!pid) {
    console.log(`No running server found for port ${port} (no ${path.relative(root, pidFile)}).`);
    console.log('If it is running, stop it with Ctrl+C in its terminal.');
    return;
  }

  if (!isAlive(pid)) {
    console.log(`Server (PID ${pid}) is not running — removing stale PID file.`);
    fs.rmSync(pidFile, { force: true });
    return;
  }

  if (!looksLikeServer(pid)) {
    console.error(`PID ${pid} does not look like the RSS reader; refusing to stop it.`);
    console.error(`Remove ${path.relative(root, pidFile)} if you are sure.`);
    process.exitCode = 1;
    return;
  }

  process.kill(pid, 'SIGTERM');

  for (let i = 0; i < 40; i++) {
    if (!isAlive(pid)) break;
    await sleep(50);
  }

  if (isAlive(pid)) {
    console.error(`Server (PID ${pid}) did not stop; sending SIGKILL.`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  fs.rmSync(pidFile, { force: true });
  console.log(`RSS reader stopped (PID ${pid}, port ${port}).`);
}

await main();
