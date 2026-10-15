// Tiny JSON disk cache under cache/. Used to avoid re-fetching things that rarely
// or never change (device list, capability profiles), so we stay under LG's API quota.
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'cache';
const LOG_MAX_BYTES = 256 * 1024; // cap for append-only logs (mqtt.log); trimmed to ~half when exceeded

export function readCache(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(name, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name), JSON.stringify(data, null, 2));
}

export function clearCache() {
  fs.rmSync(DIR, { recursive: true, force: true });
}

// Append a line to a cache file (audit log). Creates the dir if needed. The file is
// size-capped: once it passes LOG_MAX_BYTES the oldest half is dropped (on a line
// boundary) so a long-running TUI can't grow it without bound.
export function appendCache(name, text) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  fs.appendFileSync(file, text);
  try {
    const { size } = fs.statSync(file);
    if (size > LOG_MAX_BYTES) rotate(file, size);
  } catch {}
}

function rotate(file, size) {
  const keep = Math.floor(LOG_MAX_BYTES / 2);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, size - keep);
    const nl = buf.indexOf('\n');
    const tail = nl === -1 ? buf : buf.subarray(nl + 1);
    fs.writeFileSync(file, `# (log trimmed to the most recent ${keep >> 10} KB)\n`);
    fs.appendFileSync(file, tail);
  } finally {
    fs.closeSync(fd);
  }
}
