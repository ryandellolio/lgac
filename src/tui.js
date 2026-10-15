// lgac TUI — a "remote" for the ACs.
//   node src/tui.js            live (needs PAT); loads once, refresh with `r`
//   node src/tui.js --mock     dev against fixtures, no API calls
//   node src/tui.js --poll 30  opt-in auto-refresh every 30s (spends API calls)
// Keys: ←/→ switch unit · ↑/↓ temp · space on/off · m mode · f fan · a all · u/r refresh · 1-4 tabs · ? tour · q quit
// API-frugal: NO background polling by default. Control fires only on a keypress; after a
// control we re-read just that unit's live state. State is never cached, so it's always current.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useWindowSize } from 'ink';
import htm from 'htm';
import { ac, cToF, REGION_LABEL } from './client.js';
import { makeClient, loadDevices, loadDevice, loadEnergy } from './data.js';
import { makeEvents } from './mqtt.js';
import { snapshot, allowedValues, ageLabel, freshness, spinnerGlyph, shortName, truncate, cometCells } from './format.js';
import { TOUR } from './tour.js';
import { readCache, writeCache } from './cache.js';

// Merge an event's partial report into a device's state (arrays replace, objects merge).
function mergeState(state = {}, report = {}) {
  const out = { ...state };
  for (const [k, v] of Object.entries(report)) {
    if (Array.isArray(v)) out[k] = v;
    else if (v && typeof v === 'object') out[k] = { ...(out[k] || {}), ...v };
    else out[k] = v;
  }
  return out;
}

const hhmmss = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// Compact "3s" / "8m 7s" / "1h 4m" duration (no "ago").
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const jsonLines = (obj) => (obj == null ? ['(none)'] : (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)).split('\n'));
const truncLineTo = (l, w) => (l.length > w ? l.slice(0, Math.max(1, w - 1)) + '…' : l);

// Colorize one JSON line into Ink <Text> spans: keys cyan, strings green, numbers
// yellow, booleans/null magenta, punctuation grey.
function highlightLine(line, kp) {
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],])/g;
  const nodes = [];
  let i = 0;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) nodes.push(html`<${Text} key=${kp + '-' + i++}>${line.slice(last, m.index)}<//>`);
    let color = 'white';
    if (m[1] !== undefined) color = m[2] ? 'cyan' : 'green';
    else if (m[3] !== undefined) color = 'yellow';
    else if (m[4] !== undefined) color = 'magenta';
    else if (m[5] !== undefined) color = 'gray';
    nodes.push(html`<${Text} key=${kp + '-' + i++} color=${color}>${m[0]}<//>`);
    last = re.lastIndex;
  }
  if (last < line.length) nodes.push(html`<${Text} key=${kp + '-' + i++}>${line.slice(last)}<//>`);
  return nodes;
}

// Render a windowed, highlighted JSON body sized to (height rows × width cols) — no wrap.
function JsonBody({ label, obj, scroll = 0, height = 22, width = 200, kp }) {
  const lines = jsonLines(obj);
  const start = Math.min(scroll, Math.max(0, lines.length - height));
  const visible = lines.slice(Math.max(0, start), Math.max(0, start) + height);
  const end = Math.min(Math.max(0, start) + height, lines.length);
  const scrollable = lines.length > height;
  return html`
    <${Box} flexDirection="column">
      ${label != null ? html`<${Text} dimColor>${label}${scrollable ? `  ${Math.max(0, start) + 1}–${end}/${lines.length} · j/k` : ''}<//>` : null}
      ${visible.map((ln, idx) => html`<${Text} key=${'l' + (Math.max(0, start) + idx)}>${highlightLine(truncLineTo(ln, width), kp + (Math.max(0, start) + idx))}<//>`)}
    <//>`;
}

const html = htm.bind(React.createElement);
const MOCK = process.argv.includes('--mock');

// Opt-in polling: --poll <sec> or --poll=<sec>. 0 = off (the default).
const POLL = (() => {
  const i = process.argv.findIndex((a) => a === '--poll' || a.startsWith('--poll='));
  if (i === -1) return 0;
  const raw = process.argv[i].includes('=') ? process.argv[i].split('=')[1] : process.argv[i + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(10, n) : 0;
})();

// Opt-in cost estimate: LGAC_KWH_RATE=<price per kWh> in .env (any currency; shown with $).
const KWH_RATE = (() => {
  const n = Number(process.env.LGAC_KWH_RATE);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const ENERGY_DAYS = 30;
// Wh → short kWh string: 0.8 · 14.2 · 114 (drops the decimal once it stops mattering).
const kwh = (wh) => (wh == null ? '—' : wh >= 100000 ? String(Math.round(wh / 1000)) : (wh / 1000).toFixed(1));
const cost = (wh) => (wh == null ? '—' : '$' + ((wh / 1000) * KWH_RATE).toFixed(2));
const SPARK = '▁▂▃▄▅▆▇█';
const spark = (wh, max) => (wh ? SPARK[Math.min(SPARK.length - 1, Math.floor((wh / max) * SPARK.length))] : '·');

const MODES = ['COOL', 'ENERGY_SAVING', 'AIR_DRY', 'FAN'];
const FANS = ['LOW', 'MID', 'HIGH'];

// Module-scope handles so process signal handlers can tear the subscription down and
// restore the terminal (we render in the alternate screen) even if Ink's in-app Ctrl-C
// path doesn't run (e.g. signal before raw mode, or SIGTERM).
let activeEvents = null;
let inkInstance = null;
let tearingDown = false;
async function signalTeardown(code) {
  if (tearingDown) return;
  tearingDown = true;
  try {
    await Promise.race([activeEvents?.stop() ?? Promise.resolve(), sleep(4000)]);
  } catch {}
  try {
    inkInstance?.unmount();
  } catch {}
  process.exit(code);
}
process.once('SIGINT', () => signalTeardown(0));
process.once('SIGTERM', () => signalTeardown(0));
const FLASH_MS = 900; // green-flash duration after a confirmed change
const ARRIVE_MS = 1500; // arrival choreography window (drop + row fill) after a flight lands
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Control pipeline phases (mirrors POST /control -> LG cloud -> AWS IoT MQTT -> device -> GET /state).
const PHASE = {
  sending: { word: 'sending', color: 'cyan' }, // POST in flight to LG cloud
  awaiting: { word: 'awaiting event', color: 'cyan' }, // POST done, waiting for the device's MQTT push
  confirming: { word: 'confirming', color: 'yellow' }, // no event in time → GET fallback
  syncing: { word: 'syncing', color: 'yellow' },
};

// Pure: next value in a cycle (exported for testing).
export function cycle(list, current, dir = 1) {
  if (!list?.length) return current;
  const i = list.indexOf(current);
  return list[(i + dir + list.length) % list.length];
}

const PANEL_W = 34; // fixed width (roomy) so nothing reflows when values/phases/age change

function Panel({ device, selected, tick, spot, energy }) {
  const s = snapshot(device);
  const evtAge = device._lastEvent ? Date.now() - device._lastEvent : Infinity;
  const pollAge = device._lastPoll ? Date.now() - device._lastPoll : Infinity;
  const fresh = freshness(Number.isFinite(evtAge) ? evtAge : 999999, { width: 8 }); // bar = MQTT liveness
  const flashing = device._flash && Date.now() - device._flash < FLASH_MS;
  const phase = device._pending ? PHASE[device._pending] : null;
  const border = flashing ? 'green' : spot ? 'magenta' : selected ? 'cyan' : 'gray';
  const setColor = flashing ? 'green' : phase ? phase.color : 'cyan';
  // Header glyph (stable width): spinner while busy · cyan ◀ briefly when an MQTT push lands ·
  // else the online indicator (unknown = dim hollow ○, since these units don't report `online`).
  const mqttFlash = device._mqttFlash && Date.now() - device._mqttFlash < FLASH_MS;
  const glyph = phase ? spinnerGlyph(tick, false) : mqttFlash ? '◀' : s.online == null ? '○' : '●';
  const glyphColor = phase ? phase.color : mqttFlash ? 'cyan' : s.online === true ? 'green' : s.online === false ? 'red' : 'gray';
  const kv = (k, v, vColor, bold = false) =>
    html`<${Box}><${Text} dimColor>${k.padEnd(7)}<//><${Text} color=${vColor} bold=${bold}>${v}<//><//>`;
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor=${border} paddingX=${1} marginRight=${1} width=${PANEL_W}>
      <${Box} justifyContent="space-between">
        <${Text} bold>${truncate(shortName(s.alias), PANEL_W - 6)}<//>
        <${Text} color=${glyphColor}>${glyph}<//>
      <//>
      ${kv('power', s.power ? s.power.toUpperCase() : '—', s.power === 'on' ? 'green' : 'gray')}
      ${kv('mode', s.mode || '—', 'white')}
      ${kv('set', s.targetF != null ? `${s.targetF}°F / ${s.targetC ?? '—'}°C` : '—', setColor, flashing || !!phase)}
      ${kv('now', s.currentF != null ? `${s.currentF}°F / ${s.currentC ?? '—'}°C` : '—', 'white')}
      ${kv('fan', s.fan || '—', 'white')}
      ${s.filterPct != null ? kv('filter', `${s.filterPct}%`, s.filterPct <= 20 ? 'red' : s.filterPct <= 50 ? 'yellow' : 'green') : null}
      ${s.air ? kv('hum', `${s.air.humidity ?? '—'}%`, 'blue') : null}
      ${kv('energy', energy ? (energy.error ? '—' : `${kwh(energy.today ?? energy.yday)} today · ${kwh(energy.mtd)} mo kWh`) : '…', energy?.error ? 'gray' : 'white')}
      <${Box} marginTop=${1}>
        <${Text} color=${fresh.color}>${spinnerGlyph(tick, fresh.stale)} ${fresh.bar}<//>
        <${Text} color=${evtAge < 20000 ? 'cyan' : 'gray'}>  mqtt ${Number.isFinite(evtAge) ? ageLabel(evtAge) : 'none yet'}<//>
      <//>
      <${Box}><${Text} dimColor>            poll ${Number.isFinite(pollAge) ? ageLabel(pollAge) : '—'}<//><//>
    <//>`;
}

// HONESTY: a REST client only observes two things — the POST round-trip and the GET
// round-trip. Everything between (LG cloud queue → AWS IoT MQTT → device) is invisible to
// us, so it is rendered as ONE static, non-animating "opaque" segment that never pretends
// to progress. Only the two measured nodes ever change state.
function pipeNode(label, state, tick, activeColor = 'cyan') {
  const glyph = state === 'done' ? '●' : state === 'active' ? spinnerGlyph(tick, false) : '○';
  const color = state === 'done' ? 'green' : state === 'active' ? activeColor : 'gray';
  return html`<${Text} color=${color}>${glyph} ${label}<//>`;
}

// The opaque cloud→device transit rendered as an indeterminate "comet" sweep: a lit
// head slides left→right (toward the device) while a control is in flight. It is HONEST
// — motion only, never a percent — since we can't measure anything between the two REST
// round-trips. Idle → flat dim track · confirmed → a brief solid green fill.
function TransitBar({ clock, active, done, color = 'cyan', width = 34 }) {
  const cells = cometCells(clock, { width, active, done });
  return html`<${Text}>${cells.map((cell, i) =>
    html`<${Text} key=${i} color=${cell.lit ? (done ? 'green' : color) : 'gray'} dimColor=${!cell.lit}>${cell.ch}<//>`
  )}<//>`;
}

function Pipeline({ phase, tick, anim, timing, cols = 120 }) {
  const postState = phase == null ? 'pending' : phase === 'sending' ? 'active' : 'done';
  const fallback = phase === 'confirming'; // no event arrived → GET fallback
  const confState = phase === 'awaiting' || phase === 'confirming' ? 'active' : phase === 'applied' ? 'done' : 'pending';
  const confLabel = fallback || timing?.via === 'poll' ? 'GET /state (fallback)' : '◀ device event (MQTT)';
  const inFlight = phase === 'sending' || phase === 'awaiting' || phase === 'confirming';
  const applied = phase === 'applied';
  const barW = Math.max(18, Math.min(48, cols - 46));
  const detail = timing
    ? timing.via === 'mqtt'
      ? `measured: POST ${timing.post}ms · confirmed by the device's MQTT event +${timing.confirm}ms (no GET needed)`
      : `measured: POST ${timing.post}ms · no event in time → GET ${timing.get}ms · ${timing.converged ? 'applied' : 'still syncing'}`
    : phase === 'sending'
      ? 'POST /control in flight…'
      : phase === 'awaiting'
        ? "awaiting the device's own MQTT push to confirm…"
        : phase === 'confirming'
          ? 'no event yet — polling GET /state as a fallback…'
          : phase === 'applied'
            ? 'confirmed ✓'
            : 'idle — no request in flight';
  return html`
    <${Box} flexDirection="column" marginTop=${1}>
      <${Box}>
        ${pipeNode('POST /control', postState, tick)}
        <${Text} dimColor> ─▶ ( LG cloud → AWS IoT · MQTT ) ─▶ <//>
        ${pipeNode(confLabel, confState, tick, fallback ? 'yellow' : 'cyan')}
      <//>
      <${Box}>
        <${Text} dimColor>   transit <//>
        <${TransitBar} clock=${anim} active=${inFlight} done=${applied} color=${fallback ? 'yellow' : 'cyan'} width=${barW} />
        <${Text} dimColor> ${inFlight ? 'in flight — duration unknowable' : applied ? 'delivered ✓' : 'opaque · idle'}<//>
      <//>
      <${Text} dimColor>   ${detail}<//>
    <//>`;
}

// Devtools-style inspector: fixed-height two-pane (call list left · detail right), so it
// fills the terminal exactly and never overflows/wraps.
function NetworkView({ client, sel, scroll, tick, linesRef, rows, cols }) {
  const calls = client.log || [];
  const cur = calls[sel] || null;
  const respLines = jsonLines(cur?.respBody);
  if (linesRef) linesRef.current = respLines.length;

  const leftW = 46;
  const rightW = Math.max(30, cols - leftW - 5);
  const bodyH = rows; // panes are height-capped by the parent Box

  // Left: window the call list around the selection so it never exceeds the height.
  const listH = Math.max(3, rows - 1);
  const listStart = Math.max(0, Math.min(sel - Math.floor(listH / 2), Math.max(0, calls.length - listH)));
  const listRows = calls.slice(listStart, listStart + listH).map((e, k) => {
    const i = listStart + k;
    const marker = i === sel ? '▶' : ' ';
    const color = e.ok === false ? 'red' : i === sel ? 'cyan' : 'gray';
    const bare = e.path.replace(/^[A-Z]+ /, '');
    const rowStr = `${marker} #${String(e.id).padStart(3)} ${e.method.padEnd(4)} ${truncate(bare, 16).padEnd(16)} ${String(e.code ?? '—').padStart(3)} ${String(e.ms ?? '—').padStart(4)}ms`;
    return html`<${Text} key=${e.id} color=${color}>${truncLineTo(rowStr, leftW - 1)}<//>`;
  });

  // Right: fixed header section, then the response body fills the rest.
  const hdr = jsonLines(cur?.reqHeaders);
  const reqB = cur?.reqBody ? jsonLines(cur.reqBody) : [];
  const fixed = 3 + 1 + hdr.length + (reqB.length ? 1 + reqB.length : 0) + 2; // url,status,blank + labels/bodies + resp label
  const respH = Math.max(4, rows - fixed);

  return html`
    <${Box} height=${rows}>
      <${Box} flexDirection="column" width=${leftW} marginRight=${2}>
        <${Text} dimColor>${calls.length} calls · ↑/↓ select<//>
        ${listRows.length ? listRows : html`<${Text} dimColor>  (none yet)<//>`}
      <//>
      ${cur
        ? html`
        <${Box} flexDirection="column" flexGrow=${1}>
          <${Text} bold>${truncLineTo(`#${cur.id} ${cur.method} ${cur.url}`, rightW)}<//>
          <${Text} color=${cur.ok === false ? 'red' : 'green'}>${cur.ok === false ? '✗' : '✓'} ${cur.status ?? cur.code} · ${cur.ms}ms · ${hhmmss(cur.ts)}<//>
          <${Box}><${JsonBody} label="▸ request headers" obj=${cur.reqHeaders} height=${hdr.length} width=${rightW} kp="h" /><//>
          ${reqB.length ? html`<${JsonBody} label="▸ request body" obj=${cur.reqBody} height=${reqB.length} width=${rightW} kp="q" />` : null}
          <${JsonBody} label="▸ response body" obj=${cur.respBody} scroll=${scroll} height=${respH} width=${rightW} kp="r" />
        <//>`
        : html`<${Text} dimColor>select a call<//>`}
    <//>`;
}

// AWS IoT / MQTT panel — fixed height: connection facts on top, then a two-pane
// browsable message list (left) + selected payload (right).
function MqttView({ conn, info, events, sel, scroll, clientId, tick, linesRef, rows, cols, deviceNames, gut }) {
  const stateColor =
    { subscribed: 'green', connected: 'green', connecting: 'yellow', preparing: 'yellow', reconnecting: 'yellow', error: 'red', closed: 'gray', idle: 'gray' }[conn] || 'white';
  const dot = conn === 'subscribed' || conn === 'connected' ? spinnerGlyph(tick, false) : conn === 'reconnecting' ? '↻' : conn === 'error' ? '✗' : '○';
  // Reconnect line: live countdown to the next attempt (our own exponential backoff), else a drop tally.
  const retryIn = info.nextRetryAt ? Math.max(0, Math.ceil((info.nextRetryAt - Date.now()) / 1000)) : null;
  const reconnectText =
    conn === 'reconnecting'
      ? `retrying in ${retryIn ?? 0}s · attempt ${info.attempt || 1}${info.lastError ? ` · last error: ${info.lastError}` : ''}`
      : `${info.drops || 0} drop(s) this session · backoff 3s→60s · keepalive ${info.keepAlive || 30}s`;
  const line = (k, v, c) => html`<${Box}><${Text} dimColor>${k.padEnd(13)}<//><${Text} color=${c || 'white'}>${v}<//><//>`;
  const cur = events[sel] || null;
  const payloadLines = jsonLines(cur?.payload);
  if (linesRef) linesRef.current = payloadLines.length;

  const listW = 54;
  const rightW = Math.max(30, cols - listW - 5);
  const splitH = Math.max(4, rows - 12); // rows minus the header + 9-line info block + margins
  const listH = Math.max(3, splitH - 1);
  const listStart = Math.max(0, Math.min(sel - Math.floor(listH / 2), Math.max(0, events.length - listH)));
  // Summarize each event as "<unit> · <what changed, with values>" so a setpoint change
  // stands out from ambient current-temperature drift.
  const summarize = (p) => {
    const id = p?.deviceId || p?.data?.deviceId;
    const name = deviceNames?.[id] || (id ? id.slice(0, 6) + '…' : '?');
    const rep = p?.report || p?.state || {};
    const bits = [];
    const t = rep.temperature || (Array.isArray(rep.temperatureInUnits) ? rep.temperatureInUnits.find((x) => x.unit === 'C') : null);
    if (t?.targetTemperature != null) bits.push(`set ${t.targetTemperature}°${t.unit || 'C'}`);
    if (t?.currentTemperature != null) bits.push(`now ${t.currentTemperature}°${t.unit || 'C'}`);
    if (rep.operation?.airConOperationMode) bits.push(rep.operation.airConOperationMode);
    if (rep.airConJobMode?.currentJobMode) bits.push(rep.airConJobMode.currentJobMode);
    if (rep.airFlow?.windStrength) bits.push(`fan ${rep.airFlow.windStrength}`);
    const detail = bits.length ? bits.join(' · ') : Object.keys(rep).join(', ') || p?.pushType || 'event';
    return `${name} · ${detail}`;
  };
  const msgRows = events.slice(listStart, listStart + listH).map((e, k) => {
    const i = listStart + k;
    const marker = i === sel ? '▶' : ' ';
    return html`<${Text} key=${i} color=${i === sel ? 'cyan' : 'gray'}>${marker} ${hhmmss(e.ts)} ${truncLineTo(summarize(e.payload), listW - 12)}<//>`;
  });

  return html`
    <${Box} height=${rows} flexDirection="column">
      <${Box}>
        <${Text} bold color="cyan">AWS IoT · MQTT  <//>
        <${Text} color=${stateColor} bold>${dot} ${conn.toUpperCase()}<//>
        <${Text} dimColor>   (c reconnect · x disconnect${MOCK ? ' · d simulate drop' : ''} · ↑/↓ inspect · j/k scroll)<//>
      <//>
      <${Box}>${gut?.('mqtt-info')}<${Box} flexDirection="column">
        ${line('endpoint', info.endpoint || '—')}
        ${line('transport', 'MQTT/TLS :8883 · mutual-TLS (client cert)')}
        ${line('client id', clientId || '—')}
        ${line('topic', info.topic || '—')}
        ${line('cert', `${info.certCached ? 'cached · ' : ''}sha256 ${info.certFp || '—'}`)}
        ${line('device subs', String((info.deviceSubs || []).length))}
        ${line('messages', String(info.messages || 0), info.messages ? 'cyan' : 'white')}
        ${line('connected', info.connectedAt ? `${hhmmss(info.connectedAt)} (up ${dur(Date.now() - info.connectedAt)})` : '—')}
        ${line('reconnect', reconnectText, conn === 'reconnecting' ? 'yellow' : 'white')}
      <//><//>
      <${Box} flexGrow=${1} marginTop=${1}>${gut?.('mqtt-msgs')}
        <${Box} flexDirection="column" width=${listW} marginRight=${2}>
          <${Text} dimColor>messages (${events.length}) · ↑/↓<//>
          ${msgRows.length ? msgRows : html`<${Text} dimColor>  (none yet — change a unit)<//>`}
        <//>
        <${Box} flexDirection="column" flexGrow=${1}>
          ${cur
            ? html`<${JsonBody} label=${`payload · ${hhmmss(cur.ts)}`} obj=${cur.payload} scroll=${scroll} height=${splitH - 1} width=${rightW} kp="m" />`
            : html`<${Text} dimColor>select a message<//>`}
        <//>
      <//>
    <//>`;
}

// A short vertical comet that "drops" the just-confirmed result down the gutter, from the
// transit bar into the flight log — the same satisfying motion, now carried to the record.
// progress 0→1 drives the head down; idle → a flat dim gutter so the layout never jumps.
const DROP = ['█', '▓', '▒'];
function DropConnector({ progress, active, color = 'green', height = 2 }) {
  const head = active ? Math.floor(progress * (height + DROP.length)) : -99;
  return html`
    <${Box} flexDirection="column">
      ${Array.from({ length: height }, (_, r) => {
        const d = head - r;
        const lit = d >= 0 && d < DROP.length;
        return html`<${Text} key=${r} color=${lit ? color : 'gray'} dimColor=${!lit}>   ${lit ? DROP[d] : '│'}<//>`;
      })}
    <//>`;
}

// Persistent, self-describing record of each control's journey — so the fast
// in-flight moment isn't lost. Newest first. On arrival the top row illuminates
// left→right (rowP 0→1) — the transit bar's fill, echoed into the record.
function FlightLog({ flights, height = 12, cols = 120, rowP = 1 }) {
  const lit = (line, color) => {
    // Reveal the row left→right: swept chars go solid color, the moving head is bold,
    // not-yet-reached chars stay dim — so the entry "fills in" as the drop lands.
    const head = Math.floor(rowP * (line.length + 5));
    return html`<${Text}>${line.split('').map((ch, i) => {
      const d = head - i;
      const reached = d >= 0;
      const isHead = d >= 0 && d < 3;
      return html`<${Text} key=${i} color=${reached ? color : 'gray'} dimColor=${!reached} bold=${isHead}>${ch}<//>`;
    })}<//>`;
  };
  return html`
    <${Box} flexDirection="column" marginTop=${1}>
      <${Text} dimColor>▸ control flight log (newest first)<//>
      ${flights.length
        ? flights.slice(0, height).map((f, i) => {
            const tail =
              f.via === 'mqtt'
                ? `POST ${f.postMs}ms  ▶ LG cloud → AWS IoT  ◀ device event +${f.confirmMs}ms  ✓ applied`
                : f.via === 'poll'
                  ? `POST ${f.postMs}ms  ⚠ no event → GET ${f.getMs}ms  ${f.converged ? '✓ applied' : '~ still syncing'}`
                  : `POST ${f.postMs}ms  ✓ sent`;
            const color = f.via === 'poll' && !f.converged ? 'yellow' : 'green';
            const line = truncLineTo(`${hhmmss(f.ts)}  ${shortName(f.unit)} · ${f.label}   ${tail}`, cols - 1);
            return i === 0 && rowP < 1
              ? html`<${Box} key=${i}>${lit(line, color)}<//>`
              : html`<${Text} key=${i} color=${color}>${line}<//>`;
          })
        : html`<${Text} dimColor>  (change a unit to record a flight)<//>`}
    <//>`;
}

// Energy tab: one row per unit (daily kWh from GET /devices/energy/{id}/usage, 30 days back),
// a 30-day sparkline scaled to the same max for every unit so rooms are comparable, then the
// selected unit's day-by-day list. All history — LG exposes no live wattage.
function EnergyView({ devices, energy, sel, rows, cols, busy, tick }) {
  const list = devices.map((d) => ({ d, e: energy[d.id] }));
  const max = Math.max(1, ...list.flatMap(({ e }) => (e?.rows || []).map((r) => r.wh)));
  const nameW = Math.min(18, Math.max(6, ...devices.map((d) => shortName(d.alias || d.id).length)));
  const col = (v, w = 7) => String(v).padStart(w);
  const head = `${'unit'.padEnd(nameW + 2)}${col('today')}${col('yday')}${col('7d')}${col('mtd')}${col(`${ENERGY_DAYS}d`)}${KWH_RATE ? col(`$${ENERGY_DAYS}d`, 8) : ''}  last ${ENERGY_DAYS} days`;
  const sum = (k) => list.reduce((a, { e }) => a + (e?.[k] ?? 0), 0);
  const anyToday = list.some(({ e }) => e?.today != null);
  const line = (name, e, selected) => {
    if (!e) return html`<${Text} dimColor>${name.padEnd(nameW + 2)}${busy ? spinnerGlyph(tick, false) + ' loading…' : '…'}<//>`;
    if (e.error) return html`<${Text} color="red">${name.padEnd(nameW + 2)}${e.error}<//>`;
    const bars = (e.rows || []).slice(-ENERGY_DAYS).map((r) => spark(r.wh, max)).join('');
    return html`<${Box}>
      <${Text} color=${selected ? 'cyan' : 'white'} bold=${selected}>${name.padEnd(nameW + 2)}<//>
      <${Text}>${col(kwh(e.today))}${col(kwh(e.yday))}${col(kwh(e.week))}${col(kwh(e.mtd))}<//>
      <${Text} bold>${col(kwh(e.total))}<//>
      ${KWH_RATE ? html`<${Text} color="yellow">${col(cost(e.total), 8)}<//>` : null}
      <${Text} color=${selected ? 'cyan' : 'gray'}>  ${bars}<//>
    <//>`;
  };
  const cur = list[sel];
  const daily = (cur?.e?.rows || []).slice().reverse();
  const dailyRows = Math.max(0, rows - list.length - 7);
  const dmax = Math.max(1, ...daily.map((r) => r.wh));
  const barW = Math.max(10, Math.min(40, cols - 30));
  return html`
    <${Box} flexDirection="column">
      <${Text} dimColor>${head}<//>
      ${list.map(({ d, e }, i) => html`<${Box} key=${d.id}>${line(truncate(shortName(d.alias || d.id), nameW), e, i === sel)}<//>`)}
      <${Box}>
        <${Text} dimColor>${'all'.padEnd(nameW + 2)}<//>
        <${Text} bold>${col(anyToday ? kwh(sum('today')) : '—')}${col(kwh(sum('yday')))}${col(kwh(sum('week')))}${col(kwh(sum('mtd')))}${col(kwh(sum('total')))}<//>
        ${KWH_RATE ? html`<${Text} color="yellow" bold>${col(cost(sum('total')), 8)}<//>` : null}
      <//>
      <${Text} dimColor>${KWH_RATE ? `kWh · cost at $${KWH_RATE}/kWh (LGAC_KWH_RATE)` : 'kWh · set LGAC_KWH_RATE=<price per kWh> in .env for a cost column'}${anyToday ? '' : ' · today: no row from LG yet'}<//>
      ${cur
        ? html`<${Box} flexDirection="column" marginTop=${1}>
            <${Text} bold>${shortName(cur.d.alias || cur.d.id)}<${Text} dimColor> · day by day, newest first · ←/→ unit · r refresh<//><//>
            ${daily.slice(0, dailyRows).map((r) => {
              const w = r.wh ? Math.max(1, Math.round((r.wh / dmax) * barW)) : 0;
              return html`<${Box} key=${r.date}><${Text} dimColor>${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6)}  <//><${Text}>${col((r.wh / 1000).toFixed(2), 6)} <//><${Text} color=${w ? 'cyan' : 'gray'}>${w ? '▇'.repeat(w) : '·'}<//><//>`;
            })}
          <//>`
        : null}
    <//>`;
}

// The tour: one bordered explainer box per step, rendered above the footer. Each step also
// switches to the right tab and lights a ▶ gutter next to the region it describes.
// Rows the box takes at a given width (border 2 + title 1 + wrapped body lines), so the
// fixed-height views can give up exactly that much.
const tourRows = (step, ctx, cols) => 3 + step.body(ctx).reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(20, cols - 6))), 0);
function TourBox({ step, i, ctx, cols }) {
  const lines = step.body(ctx);
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX=${1} width=${Math.max(40, cols)}>
      <${Box}>
        <${Text} color="magenta" bold>TOUR ${i + 1}/${TOUR.length} · ${step.title}<//>
        <${Text} dimColor>   n/space next · b back · ? or Esc close<//>
      <//>
      ${lines.map((l, k) => html`<${Box} key=${k}><${Text} color="magenta">▸ <//><${Text}>${l}<//><//>`)}
    <//>`;
}

export function App() {
  const { exit } = useApp();
  const { rows: termRows, columns: termCols } = useWindowSize();
  const [client] = useState(() => makeClient({ mock: MOCK }));
  const [devices, setDevices] = useState([]);
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState(MOCK ? 'mock mode — no hardware touched' : 'connecting to AWS IoT…');
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null); // pending y/n gate (e.g. all on/off)
  const [tick, setTick] = useState(0);
  const [view, setView] = useState('dash'); // dash | net | mqtt | energy
  const [netSel, setNetSel] = useState(0);
  const [netScroll, setNetScroll] = useState(0);
  const [conn, setConn] = useState('idle');
  const [connInfo, setConnInfo] = useState({});
  const [feed, setFeed] = useState([]);
  const [events, setEvents] = useState([]); // raw MQTT payloads, newest first
  const [mqttSel, setMqttSel] = useState(0);
  const [mqttScroll, setMqttScroll] = useState(0);
  const [flights, setFlights] = useState([]); // control-flight records, newest first
  const [energy, setEnergy] = useState({}); // deviceId -> loadEnergy() summary
  const [energyBusy, setEnergyBusy] = useState(false);
  const energyStartedRef = useRef(false);
  const [tour, setTour] = useState(null); // null, or the index of the current tour step
  // First-run banner: "press ? for a tour", shown until the tour has been opened once (persisted).
  const [tourHint, setTourHint] = useState(() => !readCache('tour-seen.json'));
  const spot = (name) => tour != null && TOUR[tour]?.spot === name;
  // Gutter marker for a spotlightable region: ▶ on the current step's region, blank otherwise,
  // nothing at all when the tour is off (so the layout only shifts while touring).
  const gut = (name, marginTop = 0) =>
    tour == null ? null : html`<${Box} marginTop=${marginTop}><${Text} color="magenta" bold>${spot(name) ? '▶ ' : '  '}<//><//>`;
  const tourCtx = { host: client.host, region: client.region, regionLabel: REGION_LABEL[client.region] || client.region, calls: client.calls, units: devices.length, mock: MOCK, conn, info: connInfo, poll: POLL, rate: KWH_RATE, energyDays: ENERGY_DAYS };
  const tourH = (tour != null ? tourRows(TOUR[tour], tourCtx, termCols) : 0) + (tourHint ? 1 : 0); // rows taken from the views
  useEffect(() => {
    if (tour != null) setView(TOUR[tour].view); // each step opens the tab it describes
  }, [tour]);
  const logFlight = useCallback((rec) => setFlights((f) => [{ ts: Date.now(), ...rec }, ...f].slice(0, 50)), []);
  const eventsRef = useRef(null);
  const startedRef = useRef(false);
  const lastConnRef = useRef(null);
  const netLinesRef = useRef(0);
  const mqttLinesRef = useRef(0);
  const pendingRef = useRef(new Map()); // deviceId -> Set<{ expect, t0, resolve }> awaiting MQTT confirm

  // Update one device by id (functional — safe alongside event-driven replacement).
  const patchDevice = useCallback((id, patch) => setDevices((ds) => ds.map((x) => (x.id === id ? { ...x, ...patch } : x))), []);

  // Await the MQTT event that confirms a control (resolves {via,ms}) or null on timeout.
  const waitForEvent = useCallback(
    (id, expect, timeout = 8000) =>
      new Promise((resolve) => {
        // Multiple controls can be in flight for the same unit (e.g. a single-unit
        // change while an "all" sweep is confirming). Keep a SET of waiters per id so a
        // second one never orphans the first — each resolves/times out independently.
        const set = pendingRef.current.get(id) || new Set();
        pendingRef.current.set(id, set);
        const entry = { expect, t0: Date.now() };
        const drop = () => {
          set.delete(entry);
          if (set.size === 0) pendingRef.current.delete(id);
        };
        const tid = setTimeout(() => {
          drop();
          resolve(null);
        }, timeout);
        entry.resolve = (r) => {
          clearTimeout(tid);
          drop();
          resolve(r);
        };
        set.add(entry);
      }),
    []
  );

  // Local clock: re-render twice a second to animate spinners + age. NO API calls.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  // Faster clock (≈8 fps) purely for the smooth comet/drop motion — kept separate so the
  // "breathing" spinners and age labels stay on the calm 500ms beat. Still NO API calls.
  // Only runs while something is ACTUALLY moving (a control in flight, or a just-logged
  // flight still playing its arrival animation) — an idle screen costs zero re-renders.
  // The unconditional 500ms `tick` re-checks this condition, so it stops within ~500ms.
  const [anim, setAnim] = useState(0);
  useEffect(() => {
    const pending = devices.some((d) => d._pending);
    const recentFlight = flights[0] && Date.now() - flights[0].ts < ARRIVE_MS;
    if (!pending && !recentFlight) return;
    const t = setInterval(() => setAnim((x) => x + 1), 120);
    return () => clearInterval(t);
  }, [devices, flights, tick]);

  // Build an events client wired to update the UI (live MQTT, or the mock simulator).
  const spawnEvents = useCallback(() => {
    const ev = makeEvents(client, {
      onLog: (l) => setFeed((f) => [l, ...f].slice(0, 80)),
      onConn: (s, info) => {
        setConn(s);
        setConnInfo({ ...info });
        // Update the status line only on an actual transition (onConn also fires per message).
        if (s !== lastConnRef.current) {
          lastConnRef.current = s;
          const m = {
            preparing: 'connecting to AWS IoT…',
            connecting: 'connecting to AWS IoT…',
            connected: 'connected — subscribing…',
            subscribed: 'live · listening for device events',
            reconnecting: 'MQTT dropped — reconnecting with backoff (see tab 3)',
            error: 'MQTT error — see the MQTT tab (3)',
            closed: 'MQTT disconnected',
          }[s];
          if (m && !MOCK) setMsg(m);
        }
      },
      onDevice: (id, report) =>
        setDevices((ds) =>
          ds.map((d) => {
            if (d.id !== id) return d;
            const nd = { ...d, state: mergeState(d.state, report), _updatedAt: Date.now(), _updatedBy: 'event', _flash: Date.now(), _mqttFlash: Date.now(), _lastEvent: Date.now() };
            // Resolve every awaiting control this event satisfies (snapshot over the Set so
            // each waiter's own resolve() can prune itself mid-loop). If any matched, the
            // unit is no longer pending.
            const set = pendingRef.current.get(id);
            if (set) {
              const snap = snapshot(nd);
              for (const pend of [...set]) {
                if (pend.expect(snap)) {
                  nd._pending = null;
                  pend.resolve({ via: 'mqtt', ms: Date.now() - pend.t0 });
                }
              }
            }
            return nd;
          })
        ),
      onEvent: (payload) => setEvents((e) => [{ ts: Date.now(), payload }, ...e].slice(0, 100)),
    });
    eventsRef.current = ev;
    activeEvents = ev; // for the process signal backstop
    return ev;
  }, [client]);

  // Start the subscription once, after the first device load gives us ids.
  useEffect(() => {
    if (startedRef.current || devices.length === 0) return;
    startedRef.current = true;
    spawnEvents().start(devices.map((d) => d.id));
  }, [devices, spawnEvents]);

  const restartEvents = useCallback(() => {
    (async () => {
      try {
        await eventsRef.current?.stop();
      } catch {}
      spawnEvents().start(devices.map((d) => d.id));
    })();
  }, [spawnEvents, devices]);

  // Tear down the subscription before exiting so we don't leak a registered client.
  // Guarded (runs once) + time-boxed so a hung network call can't block the exit forever.
  const quittingRef = useRef(false);
  const quit = useCallback(() => {
    if (quittingRef.current) return;
    quittingRef.current = true;
    setMsg('cleaning up MQTT subscription…');
    (async () => {
      try {
        await Promise.race([eventsRef.current?.stop() ?? Promise.resolve(), sleep(4000)]);
      } catch {}
      exit();
    })();
  }, [exit]);

  // Energy history for every unit: 1 call each (sequential, so a burst can't trip the quota).
  // Runs once after the device list lands, then only on `r` from the Energy tab.
  const refreshEnergy = useCallback(async () => {
    if (!devices.length) return;
    setEnergyBusy(true);
    for (const d of devices) {
      const e = await loadEnergy(client, d.id, { days: ENERGY_DAYS });
      setEnergy((m) => ({ ...m, [d.id]: e }));
    }
    setEnergyBusy(false);
  }, [client, devices]);
  useEffect(() => {
    if (energyStartedRef.current || devices.length === 0) return;
    energyStartedRef.current = true;
    refreshEnergy();
  }, [devices, refreshEnergy]);

  const refresh = useCallback(async () => {
    try {
      const devs = await loadDevices(client);
      // Merge fresh data onto existing objects so we KEEP per-device MQTT memory
      // (_lastEvent, _mqttFlash, timings) instead of wiping it like a full replace would.
      setDevices((prev) =>
        devs.map((d) => {
          const old = prev.find((p) => p.id === d.id) || {};
          return { ...old, ...d, _updatedAt: Date.now(), _updatedBy: 'poll', _lastPoll: Date.now() };
        })
      );
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, [client]);

  // Refresh just the selected unit's state (1 API call), vs refresh() which does all.
  const refreshOne = useCallback(async () => {
    const d = devices[sel];
    if (!d) return;
    setMsg(`${d.alias}: refreshing…`);
    try {
      const fresh = await loadDevice(client, d.id);
      // Immutable patch (matches refresh()/patchDevice) — no in-place mutation of the
      // device object, so we never hand React a stale reference.
      patchDevice(d.id, {
        state: fresh.state,
        profile: fresh.profile ?? d.profile,
        _updatedAt: Date.now(),
        _updatedBy: 'poll',
        _lastPoll: Date.now(),
        _flash: Date.now(),
      });
      setMsg(`${d.alias}: refreshed ✓`);
    } catch (e) {
      setErr(e.message);
    }
  }, [client, devices, sel, patchDevice]);

  useEffect(() => {
    refresh(); // once on mount
    if (!POLL) return; // no background polling unless opted in
    const t = setInterval(refresh, POLL * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  // Send a control, then CONFIRM VIA THE MQTT EVENT (no GET poll). The device's own push
  // is the authoritative confirmation — we only fall back to one GET if no event arrives.
  const send = useCallback(
    async (payload, label, expect) => {
      const d = devices[sel];
      if (!d) return;
      const id = d.id;
      const alias = d.alias;
      const t = {};
      const t0 = Date.now();
      patchDevice(id, { _pending: 'sending' });
      setMsg(`${alias}: ${label} — POST /control`);
      try {
        // Register the event-waiter BEFORE the POST so we can't miss a fast confirm.
        const waitP = expect ? waitForEvent(id, expect) : null;
        await client.control(id, payload);
        t.post = Date.now() - t0;

        if (!expect) {
          patchDevice(id, { _pending: null, _t: t, _flash: Date.now() });
          setMsg(`${alias}: ${label} ✓ sent · POST ${t.post}ms`);
          logFlight({ unit: alias, label, postMs: t.post, via: 'sent' });
          return;
        }

        // Confirm from the device's own MQTT event (resolved by the event handler).
        patchDevice(id, { _pending: 'awaiting' });
        const conf = await waitP;
        if (conf) {
          // Confirmed by a real device event — no GET needed.
          t.confirm = conf.ms;
          t.via = 'mqtt';
          t.converged = true;
          patchDevice(id, { _t: t }); // state/flash/_pending already set by the event
          setMsg(`${alias}: ${label} ✓ confirmed by MQTT event · POST ${t.post}ms · event +${t.confirm}ms`);
          logFlight({ unit: alias, label, postMs: t.post, via: 'mqtt', confirmMs: t.confirm, converged: true });
          return;
        }

        // Fallback: no event in time — one GET to check.
        patchDevice(id, { _pending: 'confirming' });
        const g0 = Date.now();
        const st = await client.getState(id).catch(() => null);
        t.get = Date.now() - g0;
        t.via = 'poll';
        const ok = st ? expect(snapshot({ state: st })) : false;
        t.converged = ok;
        t.converge = Date.now() - t0;
        // Only overwrite state when the GET actually returned one — otherwise leave the
        // device's current (possibly event-updated) state untouched rather than reading a
        // stale `d.state` from this closure.
        const patch = { _updatedAt: Date.now(), _flash: Date.now(), _pending: null, _t: t };
        if (st) Object.assign(patch, { state: st, _updatedBy: 'poll', _lastPoll: Date.now() });
        patchDevice(id, patch);
        setMsg(`${alias}: ${label} ${ok ? '✓ applied (GET fallback)' : '~ sent, no event — still syncing'} · POST ${t.post}ms · GET ${t.get}ms`);
        logFlight({ unit: alias, label, postMs: t.post, via: 'poll', getMs: t.get, converged: ok });
      } catch (e) {
        // Don't blow away the whole id's waiter set — this send's own waiter (if any) will
        // time out on its own. Just clear the spinner.
        patchDevice(id, { _pending: null });
        setMsg(`${alias}: ${e.message}`);
      }
    },
    [client, devices, sel, patchDevice, waitForEvent]
  );

  const runAll = useCallback(
    async (on, target) => {
      const ids = devices.map((d) => d.id);
      setMsg(`ALL → ${target} — POST /control ×${ids.length}, awaiting MQTT…`);
      ids.forEach((id) => patchDevice(id, { _pending: 'sending' }));
      for (const id of ids) {
        try {
          await client.control(id, ac.power(on));
          patchDevice(id, { _pending: 'awaiting' });
          // Confirm via the device's own event; clear the spinner if none arrives in time.
          waitForEvent(id, (ns) => ns.power === (on ? 'on' : 'off')).then((conf) => {
            if (!conf) patchDevice(id, { _pending: null });
          });
        } catch {
          patchDevice(id, { _pending: null });
        }
      }
      setMsg(`ALL → ${target} ✓ dispatched · confirmations via MQTT`);
    },
    [client, devices, patchDevice, waitForEvent]
  );

  useInput((input, key) => {
    // ---- global (any view) ----
    if (key.ctrl && input === 'c') return quit();
    if (input === 'q') return quit();
    if (key.tab) return setView((v) => (v === 'dash' ? 'net' : v === 'net' ? 'mqtt' : v === 'mqtt' ? 'energy' : 'dash'));
    if (input === '1') return setView('dash');
    if (input === '2') return setView('net');
    if (input === '3') return setView('mqtt');
    if (input === '4') return setView('energy');
    if (input === '?') {
      if (tourHint) {
        setTourHint(false);
        try { writeCache('tour-seen.json', { seen: Date.now() }); } catch {}
      }
      return setTour((t) => (t == null ? 0 : null));
    }
    if (tour != null) {
      if (key.escape) return setTour(null);
      if (input === 'n' || input === ' ' || key.return || key.rightArrow || key.downArrow) return setTour((t) => Math.min(TOUR.length - 1, t + 1));
      if (input === 'b' || input === 'p' || key.leftArrow || key.upArrow) return setTour((t) => Math.max(0, t - 1));
      return; // swallow everything else — a tour keypress must never send a control
    }

    if (view === 'net') {
      const n = (client.log || []).length;
      const max = Math.max(0, netLinesRef.current - 4);
      if (key.upArrow) {
        setNetScroll(0);
        return setNetSel((i) => Math.max(0, i - 1));
      }
      if (key.downArrow) {
        setNetScroll(0);
        return setNetSel((i) => Math.min(Math.max(n - 1, 0), i + 1));
      }
      if (input === 'j') return setNetScroll((s) => Math.min(max, s + 3));
      if (input === 'k') return setNetScroll((s) => Math.max(0, s - 3));
      return;
    }
    if (view === 'mqtt') {
      if (input === 'c') return restartEvents();
      if (input === 'x') return void eventsRef.current?.stop();
      if (input === 'd' && MOCK) return void eventsRef.current?.simulateDrop?.();
      const n = events.length;
      const max = Math.max(0, mqttLinesRef.current - 4);
      if (key.upArrow) {
        setMqttScroll(0);
        return setMqttSel((i) => Math.max(0, i - 1));
      }
      if (key.downArrow) {
        setMqttScroll(0);
        return setMqttSel((i) => Math.min(Math.max(n - 1, 0), i + 1));
      }
      if (input === 'j') return setMqttScroll((s) => Math.min(max, s + 3));
      if (input === 'k') return setMqttScroll((s) => Math.max(0, s - 3));
      return;
    }

    if (view === 'energy') {
      if (key.rightArrow) return setSel((i) => (i + 1) % Math.max(devices.length, 1));
      if (key.leftArrow) return setSel((i) => (i - 1 + devices.length) % Math.max(devices.length, 1));
      if (input === 'r' && !energyBusy) {
        setMsg(`energy: refreshing ${devices.length} units (${devices.length} calls)…`);
        return refreshEnergy();
      }
      return;
    }

    // ---- dashboard ----
    if (confirm) {
      const run = confirm.run;
      setConfirm(null);
      if (input === 'y' || input === 'Y') return run();
      return setMsg('cancelled');
    }
    const d = devices[sel];
    if (key.rightArrow) return setSel((i) => (i + 1) % Math.max(devices.length, 1));
    if (key.leftArrow) return setSel((i) => (i - 1 + devices.length) % Math.max(devices.length, 1));
    if (input === 'r') return refresh(); // all units
    if (input === 'u') return refreshOne(); // just the selected unit (1 call)
    if (input === 'a') {
      if (!devices.length) return;
      const anyOn = devices.some((x) => snapshot(x).power === 'on');
      const target = anyOn ? 'OFF' : 'ON';
      setConfirm({ run: () => runAll(!anyOn, target) });
      return setMsg(`⚠  Turn ALL ${devices.length} units ${target}?  press y to confirm · any other key cancels`);
    }
    if (!d) return;
    const s = snapshot(d);
    const stepC = (delta) => {
      const next = Math.min(30, Math.max(16, Math.round(((s.targetC ?? 21) + delta) / 0.5) * 0.5));
      return send(ac.tempC(next), `set ${next}°C / ${cToF(next)}°F`, (ns) => ns.targetC === next);
    };
    if (key.upArrow) return stepC(0.5);
    if (key.downArrow) return stepC(-0.5);
    if (input === ' ') {
      const on = s.power !== 'on';
      return send(ac.power(on), on ? 'power on' : 'power off', (ns) => ns.power === (on ? 'on' : 'off'));
    }
    if (input === 'm') {
      const next = cycle(allowedValues(d, 'airConJobMode', 'currentJobMode') || MODES, s.mode, 1);
      return send(ac.mode(next), `mode ${next}`, (ns) => ns.mode === next);
    }
    if (input === 'f') {
      const next = cycle(allowedValues(d, 'airFlow', 'windStrength') || FANS, s.fan, 1);
      return send(ac.fan(next), `fan ${next}`, (ns) => ns.fan === next);
    }
  });

  const statusColor = confirm ? 'yellow' : err ? 'red' : 'green';
  const activeDev = devices.find((d) => d._pending);
  const flashingDev = !activeDev && devices.find((d) => d._flash && Date.now() - d._flash < FLASH_MS);
  const pipePhase = activeDev ? activeDev._pending : flashingDev ? 'applied' : null;
  const pipeTiming = !activeDev && flashingDev ? flashingDev._t : null;

  // Badge reflects the REAL connection health, not just mock-vs-live.
  const badge = MOCK ? 'MOCK' : conn === 'subscribed' || conn === 'connected' ? 'LIVE' : conn === 'reconnecting' ? 'RECONNECTING' : conn === 'connecting' || conn === 'preparing' ? 'CONNECTING' : 'OFFLINE';
  const badgeColor = { MOCK: 'gray', LIVE: 'green', RECONNECTING: 'yellow', CONNECTING: 'yellow', OFFLINE: 'red' }[badge];
  const tab = (n, label, extra) =>
    html`<${Text} color=${view === n ? 'cyan' : 'gray'} bold=${view === n}>${view === n ? '▸' : ' '}${label}${extra || ''}<//>`;

  // Arrival choreography: when a flight is freshly logged, the comet first drops down the
  // gutter, then the newest log row fills in — sequenced over ARRIVE_MS from its timestamp
  // (real elapsed time → frame-rate independent; `anim` just forces the re-renders).
  const newest = flights[0];
  const arriveAge = newest ? Date.now() - newest.ts : Infinity;
  const arriving = arriveAge < ARRIVE_MS;
  const p = arriving ? arriveAge / ARRIVE_MS : 1;
  const dropP = Math.min(1, p / 0.45); // drop finishes first ~45% of the window
  const rowP = arriving ? Math.max(0, (p - 0.4) / 0.6) : 1; // row fills through the rest
  const dropColor = newest && newest.via === 'poll' && !newest.converged ? 'yellow' : 'green';

  const dashBody = html`
    <${Box} flexDirection="column">
      <${Box}>
        ${gut('panel')}
        ${devices.length
          ? devices.map((d, i) => html`<${Panel} key=${d.id} device=${d} selected=${i === sel} tick=${tick} spot=${spot('panel') && i === sel} energy=${energy[d.id]} />`)
          : html`<${Text} dimColor>loading…<//>`}
      <//>
      <${Box} marginTop=${1}>${gut('status')}<${Text} color=${statusColor}>${err ? `error: ${err}` : msg}<//><//>
      <${Box}>${gut('pipeline', 1)}<${Pipeline} phase=${pipePhase} tick=${tick} anim=${anim} timing=${pipeTiming} cols=${termCols - (tour != null ? 2 : 0)} /><//>
      <${Box} marginTop=${1}>${gut('infra')}<${Text} dimColor>▸ ${client.host} · region ${client.region} (${REGION_LABEL[client.region] || client.region}) · Bearer PAT · ${client.calls} calls this session<//><//>
      <${Box}>
        ${gut('flights', 3)}
        <${Box} flexDirection="column">
          <${DropConnector} progress=${dropP} active=${arriving} color=${dropColor} />
          <${FlightLog} flights=${flights} cols=${termCols} rowP=${rowP} height=${tour != null ? 3 : 12} />
        <//>
      <//>
    <//>`;

  const footer =
    tour != null
      ? 'TOUR · n/space next · b back · Tab/1·2·3·4 peek at other views · ? or Esc close · q quit'
      : view === 'dash'
        ? '←/→ unit · ↑/↓ temp · space power · m mode · f fan · a all(confirm) · u/r refresh · Tab/1·2·3·4 views · ? tour · q quit'
        : view === 'net'
          ? '↑/↓ select call · j/k scroll body · Tab/1·2·3·4 views · ? tour · q quit'
          : view === 'energy'
            ? '←/→ unit · r refresh energy (1 call per unit) · Tab/1·2·3·4 views · ? tour · q quit'
            : `↑/↓ inspect message · j/k scroll · c reconnect · x disconnect${MOCK ? ' · d drop' : ''} · Tab/1·2·3·4 views · ? tour · q quit`;

  return html`
    <${Box} flexDirection="column" height=${termRows}>
      <${Box}>
        ${gut('header')}
        <${Text} bold color="cyan">LG ThinQ Remote  <//>
        <${Text} color=${badgeColor} bold>[${badge}]<//>
        <${Text} dimColor> · ${devices.length}u · ${REGION_LABEL[client.region] || client.region}    <//>
        ${tab('dash', '1 Dashboard')}<${Text} dimColor>   <//>
        ${tab('net', '2 Network', ` (${(client.log || []).length})`)}<${Text} dimColor>   <//>
        ${tab('mqtt', '3 MQTT', ` (${events.length})`)}<${Text} dimColor>   <//>
        ${tab('energy', '4 Energy')}
      <//>
      ${tourHint ? html`<${Box}><${Text} color="magenta" bold>Press ? for a guided tour of this screen<//><//>` : null}
      <${Box} marginTop=${1} flexDirection="column" flexGrow=${1}>
        ${view === 'dash'
          ? dashBody
          : view === 'net'
            ? html`<${Box}>${gut('net')}<${NetworkView} client=${client} sel=${netSel} scroll=${netScroll} tick=${tick} linesRef=${netLinesRef} rows=${Math.max(8, termRows - 4 - tourH)} cols=${termCols - (tour != null ? 2 : 0)} /><//>`
            : view === 'energy'
              ? html`<${Box}>${gut('energy')}<${EnergyView} devices=${devices} energy=${energy} sel=${sel} busy=${energyBusy} tick=${tick} rows=${Math.max(8, termRows - 4 - tourH)} cols=${termCols - (tour != null ? 2 : 0)} /><//>`
              : html`<${MqttView} conn=${conn} info=${connInfo} events=${events} sel=${mqttSel} scroll=${mqttScroll} clientId=${client.clientId} tick=${tick} linesRef=${mqttLinesRef} rows=${Math.max(8, termRows - 4 - tourH)} cols=${termCols - (tour != null ? 2 : 0)} deviceNames=${Object.fromEntries(devices.map((d) => [d.id, shortName(d.alias || d.id)]))} gut=${gut} />`}
      <//>
      ${tour != null ? html`<${TourBox} step=${TOUR[tour]} i=${tour} ctx=${tourCtx} cols=${termCols} />` : null}
      <${Box} marginTop=${1}>${gut('footer')}<${Text} dimColor>${footer}<//><//>
    <//>`;
}

// Only take over the terminal when run directly (keeps the module importable for tests).
// exitOnCtrlC:false — we handle Ctrl-C ourselves so the MQTT teardown can finish first.
// alternateScreen — full-screen like vim/htop; your scrollback is restored untouched on quit.
if (process.stdin.isTTY) {
  inkInstance = render(html`<${App} />`, { exitOnCtrlC: false, alternateScreen: true });
  // A throw during render (e.g. no PAT) would otherwise vanish with the alternate screen.
  inkInstance.waitUntilExit().catch((e) => {
    console.error(`lgac: ${e.message}`);
    process.exit(1);
  });
} else if (!process.env.LGAC_TEST) {
  console.error('The TUI needs an interactive terminal. Run: lgac tui' + (MOCK ? ' --mock' : ''));
  process.exit(1);
}
