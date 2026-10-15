// One data interface used by both the CLI and the TUI, built to minimize API calls.
//
// Cost model (per LG's quota): every getState is 1 call. The device LIST and each
// capability PROFILE almost never change, so we cache them to disk and only pay for
// live STATE. Control commands resolve aliases from the cached list (0 calls) and
// send just the control (1 call).
import './env.js';
import fs from 'node:fs';
import { ThinqClient, loadConfig } from './client.js';
import { readCache, writeCache } from './cache.js';

export function makeClient({ mock } = {}) {
  const client = mock ? new MockClient(mock === true ? undefined : mock) : new ThinqClient(loadConfig());
  client.mock = !!mock;
  return client;
}

// Device list (id/alias/model/type), cached — 0 API calls once warm.
export async function getDeviceList(client, { fresh = false } = {}) {
  if (!client.mock && !fresh) {
    const cached = readCache('devices.json');
    if (cached) return cached;
  }
  const list = await client.listDevices();
  const devices = list.map((d) => {
    const i = d.deviceInfo || d;
    return { id: d.deviceId, alias: i.alias, model: i.modelName || i.deviceType, type: i.deviceType, online: i.online };
  });
  if (!client.mock) writeCache('devices.json', devices);
  return devices;
}

// One device's capability profile, cached (profiles are static) — 0 calls once warm.
export async function getProfile(client, id, { fresh = false } = {}) {
  if (client.mock) return client.getProfile(id);
  const cache = readCache('profiles.json') || {};
  if (!fresh && cache[id]) return cache[id];
  const profile = await client.getProfile(id);
  cache[id] = profile;
  writeCache('profiles.json', cache);
  return profile;
}

// Full snapshot of every device WITH live state (list + profiles cached, N state calls).
export async function loadDevices(client, { fresh = false } = {}) {
  const list = await getDeviceList(client, { fresh });
  const out = [];
  for (const d of list) {
    const profile = await getProfile(client, d.id, { fresh }).catch(() => null);
    const state = await client.getState(d.id).catch(() => null);
    out.push({ ...d, profile, state });
  }
  return out;
}

// One device with live state — used by `status <unit>` (1 state call).
export async function loadDevice(client, id, { fresh = false } = {}) {
  const meta = (await getDeviceList(client, { fresh })).find((d) => d.id === id) || { id };
  const [profile, state] = await Promise.all([
    getProfile(client, id, { fresh }).catch(() => null),
    client.getState(id).catch(() => null),
  ]);
  return { ...meta, profile, state };
}

// Match a unit by alias (case-insensitive substring) or id. Returns the device id.
export function resolveUnit(devices, query) {
  if (!query) return devices[0]?.id;
  const q = String(query).toLowerCase();
  const hit =
    devices.find((d) => d.id === query) ||
    devices.find((d) => (d.alias || '').toLowerCase() === q) ||
    devices.find((d) => (d.alias || '').toLowerCase().includes(q)) ||
    devices.find((d) => (d.id || '').toLowerCase().includes(q));
  return hit?.id;
}

// Resolve an alias/id to a device id using only the cached list — 0 API calls when warm.
export async function resolveUnitId(client, query, { fresh = false } = {}) {
  return resolveUnit(await getDeviceList(client, { fresh }), query);
}

// ---- Mock backend ----
class MockClient {
  constructor(path) {
    this.store = loadFixture(path);
    this.region = 'mock';
    this.host = 'fixtures (offline)';
    this.clientId = 'mock-client-0000-abcd';
    this.calls = 0;
    this.lastPath = null;
    this.log = [];
    this._seq = 0;
    this.onControl = null; // MockEvents hooks this to emit a confirming event on control
  }
  async listDevices() {
    const resp = this.store.map((d) => ({
      deviceId: d.id,
      deviceInfo: { alias: d.alias, modelName: d.model, deviceType: d.type, online: d.online },
    }));
    this._hit('GET', '/devices', null, resp);
    return resp;
  }
  async getProfile(id) {
    const resp = this._find(id)?.profile ?? null;
    this._hit('GET', `/devices/${id}/profile`, null, resp);
    return resp;
  }
  async getState(id) {
    const resp = this._find(id)?.state ?? null;
    this._hit('GET', `/devices/${id}/state`, null, resp);
    return resp;
  }
  async control(id, payload) {
    applyControl(this._find(id)?.state, payload);
    const resp = { message: 'mock control applied', body: payload };
    this._hit('POST', `/devices/${id}/control`, payload, resp);
    if (this.onControl) setTimeout(() => this.onControl(id), 250); // async confirming event (like real latency)
    return resp;
  }
  // Energy stubs: a plausible daily series so `lgac --mock energy` renders a table.
  async getEnergyProfile(id) {
    const resp = { resultCode: '0000', result: { property: ['energyUsage'] } };
    this._hit('GET', `/devices/energy/${id}/profile`, null, resp);
    return resp;
  }
  async getEnergyUsage(id, q) {
    // Same shape as the live API (Wh per day/month), with dates walked from startDate to
    // endDate so "today"/"yesterday" resolve on whatever day the mock runs. Per-unit offset
    // so the three panels don't show identical numbers.
    const monthly = q.period === 'MONTHLY';
    const seed = [0, 79, 1120, 1, 0, 52, 640, 910, 330, 0, 1480, 760];
    const off = Math.abs([...String(id)].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % seed.length;
    const rows = [];
    const d = new Date(Number(q.startDate.slice(0, 4)), Number(q.startDate.slice(4, 6)) - 1, monthly ? 1 : Number(q.startDate.slice(6, 8)));
    for (let i = 0; i < 400; i++) {
      const key = monthly ? ymd(d).slice(0, 6) : ymd(d);
      if (key > q.endDate) break;
      rows.push({ usedDate: key, energyUsage: seed[(i + off) % seed.length] * (monthly ? 25 : 1) });
      if (monthly) d.setMonth(d.getMonth() + 1);
      else d.setDate(d.getDate() + 1);
    }
    const resp = { resultCode: '0000', result: { dataList: rows, property: ['energyUsage'] } };
    this._hit('GET', `/devices/energy/${id}/usage`, null, resp);
    return resp;
  }
  // MQTT/event REST stubs so `lgac --mock mqtt-*` doesn't crash (live-only in practice).
  async listEventSubscriptions() {
    this._hit('GET', '/event', null, []);
    return [];
  }
  async unsubscribeEvent(id) {
    this._hit('DELETE', `/event/${id}/unsubscribe`, null, {});
    return {};
  }
  async deregisterClient() {
    this._hit('DELETE', '/client', null, {});
    return {};
  }
  _hit(method, path, reqBody, respBody) {
    this.calls += 1;
    this.lastPath = `${method} ${path}`;
    this.log.unshift({
      id: ++this._seq,
      ts: Date.now(),
      method,
      path: `${method} ${path}`,
      url: `mock://${path}`,
      reqHeaders: { note: '(mock — no real HTTP request)' },
      reqBody: reqBody ?? null,
      status: 200,
      ok: true,
      code: 200,
      ms: 1 + (this.calls % 7),
      respBody,
    });
    if (this.log.length > 40) this.log.pop();
  }
  _find(id) {
    return this.store.find((d) => d.id === id);
  }
}

function loadFixture(path) {
  const candidates = [path, 'fixtures/state.json', 'fixtures/sample.json'].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error('No mock fixture found (fixtures/sample.json missing).');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw.devices)) return raw.devices.map(normDevice);
  if (Array.isArray(raw)) return raw.map(normDevice);
  // Single-device capture (the original proof-of-concept dump): { device, profile, state }
  const info = raw.device?.deviceInfo || raw.device || {};
  return [normDevice({ id: raw.device?.deviceId, alias: info.alias, model: info.modelName, type: info.deviceType, online: info.online, profile: raw.profile, state: raw.state })];
}

function normDevice(d) {
  return { id: d.id, alias: d.alias, model: d.model, type: d.type || 'DEVICE_AIR_CONDITIONER', online: d.online ?? true, profile: d.profile ?? null, state: d.state ?? {} };
}

// Merge a control payload into mock state so the UI reflects the change.
function applyControl(state, payload) {
  if (!state) return;
  for (const [res, props] of Object.entries(payload)) {
    if ((res === 'temperature' || res === 'temperatureInUnits') && props.targetTemperature != null) {
      const cVal = props.unit === 'F' ? Math.round(((props.targetTemperature - 32) * 5) / 9 / 0.5) * 0.5 : props.targetTemperature;
      setMockTarget(state, cVal);
    } else {
      state[res] = { ...(state[res] || {}), ...props };
    }
  }
}

// Set the target in both °C and °F across whichever temperature shapes exist.
function setMockTarget(state, cVal) {
  const fVal = Math.round((cVal * 9) / 5 + 32);
  const apply = (t) => {
    if (t.unit === 'C') t.targetTemperature = cVal;
    else if (t.unit === 'F') t.targetTemperature = fVal;
  };
  for (const key of ['temperature', 'temperatureInUnits']) {
    const v = state[key];
    if (Array.isArray(v)) v.forEach(apply);
    else if (v && v.unit) apply(v);
    else if (v) v.targetTemperature = cVal;
  }
}

// ---- Energy (LG's devices/energy/{id}/profile + /usage) ----
// Daily rows are Wh totals per LOCAL calendar day; there is no live wattage anywhere in the
// API, so everything here is history. Dates must be local (LG rejects a future end date, and
// UTC rolls over at 8pm ET).
export const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// Which energy properties a unit reports (e.g. ['energyUsage']). Static → cached on disk,
// so this is 0 calls once warm.
export async function getEnergyProperty(client, id, { fresh = false } = {}) {
  const profiles = (!client.mock && readCache('energy-profiles.json')) || {};
  let prof = !fresh ? profiles[id] : null;
  if (!prof) {
    prof = await client.getEnergyProfile(id);
    if (!client.mock) writeCache('energy-profiles.json', { ...profiles, [id]: prof });
  }
  const props = prof?.result?.property || prof?.property || [];
  return { property: props[0] || null, profile: prof };
}

// Normalize a usage response to [{ date, wh }] (ascending by date). Any unknown shape → [].
export function energyRows(res, property) {
  const rows = res?.result?.dataList || (Array.isArray(res?.result) ? res.result : Array.isArray(res) ? res : null);
  if (!rows?.length) return [];
  const dateKey = Object.keys(rows[0]).find((k) => /date|month|day/i.test(k)) || 'usedDate';
  const valKey = rows[0][property] != null ? property : Object.keys(rows[0]).find((k) => k !== dateKey && typeof rows[0][k] === 'number');
  return rows.map((r) => ({ date: String(r[dateKey]), wh: Number(r[valKey]) || 0 })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Last `days` days of one unit, summarized for the TUI: 1 call (2 when the profile is cold).
// Returns { property, rows, today, yday, week, mtd, total, fetchedAt } with all values in Wh,
// or { error } so a quota error on one unit never blocks the rest.
export async function loadEnergy(client, id, { days = 30 } = {}) {
  try {
    const { property } = await getEnergyProperty(client, id);
    if (!property) return { error: 'no energy property', rows: [] };
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - (days - 1));
    const res = await client.getEnergyUsage(id, { property, period: 'DAILY', startDate: ymd(start), endDate: ymd(now) });
    const rows = energyRows(res, property);
    const by = Object.fromEntries(rows.map((r) => [r.date, r.wh]));
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const month = ymd(now).slice(0, 6);
    const last7 = rows.slice(-7);
    return {
      property,
      rows,
      today: by[ymd(now)] ?? null, // null = LG hasn't produced a row for today (yet)
      yday: by[ymd(y)] ?? 0,
      week: last7.reduce((a, r) => a + r.wh, 0),
      mtd: rows.filter((r) => r.date.startsWith(month)).reduce((a, r) => a + r.wh, 0),
      total: rows.reduce((a, r) => a + r.wh, 0),
      fetchedAt: Date.now(),
    };
  } catch (e) {
    return { error: e.message, rows: [] };
  }
}
