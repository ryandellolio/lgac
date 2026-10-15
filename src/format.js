// Turn LG's nested profile+state into a clean, render-ready snapshot.
// Written defensively: real units, mock fixtures, and older shapes all differ,
// so every extractor tolerates missing/alternate shapes.
import { cToF as cToFraw } from './client.js';

// ---- minimal ANSI (no deps) ----
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32),
  yellow: wrap(33), blue: wrap(34), cyan: wrap(36), gray: wrap(90),
};

const cToF = (c) => (c == null ? null : cToFraw(c));
const fToCd = (f) => (f == null ? null : Math.round(((f - 32) * 5) / 9 / 0.5) * 0.5); // display only, unclamped

// Real units expose temperatureInUnits (array of {unit,current,target}); mock uses
// a temperature array; older shape is a single object. Return BOTH °F and °C.
function pickTemp(state) {
  const grab = (unit, field) => {
    const arr = state?.temperatureInUnits;
    if (Array.isArray(arr)) {
      const e = arr.find((t) => t.unit === unit);
      if (e && e[field] != null) return e[field];
    }
    let t = state?.temperature;
    if (Array.isArray(t)) {
      const e = t.find((x) => x.unit === unit);
      if (e && e[field] != null) return e[field];
    } else if (t && t.unit === unit && t[field] != null) return t[field];
    return null;
  };
  let curF = grab('F', 'currentTemperature'), curC = grab('C', 'currentTemperature');
  let tgtF = grab('F', 'targetTemperature'), tgtC = grab('C', 'targetTemperature');
  if (curF == null) curF = cToF(curC);
  if (curC == null) curC = fToCd(curF);
  if (tgtF == null) tgtF = cToF(tgtC);
  if (tgtC == null) tgtC = fToCd(tgtF);
  return { currentF: curF, currentC: curC, targetF: tgtF, targetC: tgtC };
}

function pickPower(state) {
  const v = state?.operation?.airConOperationMode;
  if (v == null) return null;
  return String(v).toUpperCase().includes('ON') ? 'on' : 'off';
}

// Any timer that is actually set (LG reports "UNSET" otherwise). Returns [{name, value}].
function pickTimers(state) {
  const out = [];
  for (const [res, label] of [['timer', ''], ['sleepTimer', 'sleep ']]) {
    for (const [k, v] of Object.entries(state?.[res] || {})) {
      if (v == null || v === 'UNSET') continue;
      out.push({ name: label + k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: v });
    }
  }
  return out;
}

function pickAir(state) {
  const a = state?.airQualitySensor;
  if (!a) return null;
  return { pm1: a.PM1, pm2: a.PM2, pm10: a.PM10, humidity: a.humidity, odor: a.odorLevel ?? a.odor };
}

// Normalized, UI-friendly view of one unit.
export function snapshot(device = {}) {
  const s = device.state || {};
  const t = pickTemp(s);
  return {
    id: device.id,
    alias: device.alias || device.id,
    model: device.model || device.type || '',
    online: device.online,
    power: pickPower(s),
    mode: s.airConJobMode?.currentJobMode ?? null,
    fan: s.airFlow?.windStrength ?? s.airFlow?.windStrengthDetail ?? null,
    windStep: s.airFlow?.windStep ?? null,
    currentF: t.currentF, currentC: t.currentC,
    targetF: t.targetF, targetC: t.targetC,
    powerSave: s.powerSave?.powerSaveEnabled ?? null,
    // Newer firmware/API reports the unit's own setpoint bounds (°C) — null on older state.
    minTargetC: s.temperature?.minTargetTemperature ?? null,
    maxTargetC: s.temperature?.maxTargetTemperature ?? null,
    runState: s.runState?.currentState ?? null,
    timers: pickTimers(s),
    filterPct: s.filterInfo?.filterRemainPercent ?? null,
    air: pickAir(s),
  };
}

// Allowed values for an enum property, read from the profile if present.
export function allowedValues(device, resource, prop) {
  const p = device?.profile?.property?.[resource]?.[prop];
  const v = p?.value;
  return v?.w || v?.r || (Array.isArray(v) ? v : null);
}

const dot = (online) => (online === false ? c.red('●') : c.green('●'));
const power = (p) => (p === 'on' ? c.green('ON') : p === 'off' ? c.gray('OFF') : c.dim('?'));
// "72°F / 22°C", dimming the °C half.
const temp = (f, cc) => (f == null && cc == null ? c.dim('—') : `${f != null ? `${f}°F` : '—'}${c.dim(` / ${cc != null ? `${cc}°C` : '—'}`)}`);

// One-line summary for `lgac list`.
export function row(device) {
  const s = snapshot(device);
  const name = c.bold(s.alias.padEnd(20));
  return `${dot(s.online)} ${name} ${power(s.power).padEnd(12)} ${(s.mode || '—').padEnd(14)} ` +
    `${temp(s.currentF, s.currentC)} → ${temp(s.targetF, s.targetC)}  fan ${s.fan || '—'}`;
}

// Full block for `lgac status`.
export function detail(device) {
  const s = snapshot(device);
  const L = (label, val) => `  ${c.dim(label.padEnd(10))} ${val}`;
  const lines = [
    `${dot(s.online)} ${c.bold(s.alias)} ${c.gray(`(${s.model})`)}  ${s.online === false ? c.red('offline') : c.green('online')}`,
    L('power', power(s.power)),
    L('mode', s.mode || c.dim('—')),
    L('now', temp(s.currentF, s.currentC)),
    L('set', c.cyan(`${s.targetF != null ? `${s.targetF}°F` : '—'}`) + c.dim(` / ${s.targetC != null ? `${s.targetC}°C` : '—'}`)),
    L('fan', s.fan ? `${s.fan}${s.windStep != null ? c.dim(` (step ${s.windStep})`) : ''}` : c.dim('—')),
  ];
  if (s.minTargetC != null || s.maxTargetC != null) lines.push(L('range', c.dim(`${s.minTargetC ?? '—'}–${s.maxTargetC ?? '—'}°C`)));
  if (s.runState && s.runState !== 'NORMAL') lines.push(L('state', c.yellow(s.runState)));
  for (const t of s.timers) lines.push(L('timer', `${t.name}: ${t.value}`));
  if (s.powerSave != null) lines.push(L('powersave', s.powerSave ? 'on' : 'off'));
  if (s.filterPct != null) lines.push(L('filter', `${filterColor(s.filterPct)} remaining`));
  if (s.air) {
    lines.push(L('air', `PM2.5 ${s.air.pm2 ?? '—'} · PM10 ${s.air.pm10 ?? '—'} · humidity ${s.air.humidity ?? '—'}%`));
  }
  return lines.join('\n');
}

function filterColor(pct) {
  const txt = `${pct}%`;
  return pct <= 20 ? c.red(txt) : pct <= 50 ? c.yellow(txt) : c.green(txt);
}

// ---- data-freshness helpers (used by the TUI; driven by a local clock, no API) ----

// "just now" / "5s ago" / "2m 3s ago" / "1h 4m ago"
export function ageLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

// A draining bar + color + stale flag for a given data age.
export function freshness(ms, { staleAt = 120000, width = 10 } = {}) {
  const frac = Math.max(0, Math.min(1, 1 - ms / staleAt));
  const filled = Math.round(width * frac);
  const s = ms / 1000;
  return {
    bar: '█'.repeat(filled) + '░'.repeat(width - filled),
    color: s < 20 ? 'green' : 'gray', // fresh = green, aged = calm grey (never red/angry)
    stale: frac <= 0,
  };
}

// Spinner glyph that "breathes" while fresh, freezes to a hollow ring when stale.
const SPIN = ['◐', '◓', '◑', '◒'];
export const spinnerGlyph = (tick, stale) => (stale ? '○' : SPIN[tick % SPIN.length]);

// Indeterminate "comet" for a leg whose duration we CANNOT measure (the opaque
// LG-cloud → AWS-IoT → device transit). A short lit head sweeps left→right over a
// dim track to signal motion — honestly, since it never claims a percent. Returns
// per-cell {ch, lit} so the caller can color the head and dim the track.
//   active → sweeping · idle → flat dim track · done → solid fill.
const COMET = ['█', '▓', '▒']; // brightest at the head, fading behind
export function cometCells(tick, { width = 40, active = true, done = false } = {}) {
  if (done) return Array.from({ length: width }, () => ({ ch: '█', lit: true }));
  if (!active) return Array.from({ length: width }, () => ({ ch: '─', lit: false }));
  const period = width + COMET.length + 2; // pause off the right edge before wrapping
  const head = tick % period;
  return Array.from({ length: width }, (_, i) => {
    const d = head - i; // cells at/behind the head are lit
    return d >= 0 && d < COMET.length ? { ch: COMET[d], lit: true } : { ch: '─', lit: false };
  });
}

// Drop the redundant " Air Conditioner"/" AC" suffix for a tidy panel title.
export const shortName = (alias = '') => alias.replace(/\s*(air conditioner|a\/c|ac)\s*$/i, '').trim() || alias;

// Truncate with an ellipsis so panels stay a fixed width.
export const truncate = (s = '', n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
