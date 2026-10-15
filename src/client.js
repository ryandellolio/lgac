// Minimal LG ThinQ Connect API client (official Open API, PAT auth).
// No SDK — just fetch. Contract verified against LG's thinqconnect Python source.
import crypto from 'node:crypto';

// Public API key baked into LG's own SDK (thinqconnect/const.py).
const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3';

// country -> region domain prefix, the complete table from LG's SDK (thinqconnect/country.py).
//   aic = Americas (api-aic) · eic = Europe/Middle East/Africa (api-eic) · kic = Asia-Pacific (api-kic)
const REGIONS = {
  aic: 'AG AR AW BB BO BR BS BZ CA CL CO CR CU DM DO EC GD GT GY HN HT JM KN LC MX NI PA PE PR PY SR SV TT US UY VC VE',
  eic: 'AE AF AL AM AO AT AZ BA BE BF BG BH BJ BY CD CF CG CH CI CM CV CY CZ DE DJ DK DZ EE EG ES ET FI FR GA GB GE GH GM GN GQ GR HR HU IE IL IQ IR IS IT JO KE KG KW KZ LB LR LT LU LV LY MA MD ME MK ML MR MT MU MW NE NG NL NO OM PK PL PS PT QA RO RS RU RW SA SD SE SI SK SL SN SO ST SY TD TG TN TR TZ UA UG UZ XK YE ZA ZM',
  kic: 'AU BD CN HK ID IN JP KH KR LA LK MM MY NP NZ PH SG TH TW VN',
};
const REGION_BY_COUNTRY = Object.fromEntries(Object.entries(REGIONS).flatMap(([r, cs]) => cs.split(' ').map((c) => [c, r])));

function regionFor(country) {
  const r = REGION_BY_COUNTRY[country?.toUpperCase()];
  if (!r) throw new Error(`Unsupported country "${country}" (set LGAC_COUNTRY to the ISO code of your LG account's country, e.g. US, GB, KR).`);
  return r;
}

// base64url of 16 random bytes, no padding — matches SDK's _generate_message_id.
function messageId() {
  return crypto.randomBytes(16).toString('base64url');
}

// Human-readable names for LG's error codes (subset of thinq_api.py).
const ERROR_NAMES = {
  '1103': 'INVALID_TOKEN', '1104': 'INVALID_MESSAGE_ID', '1219': 'NOT_SUPPORTED_MODEL',
  '1220': 'NOT_SUPPORTED_FEATURE', '1306': 'EXCEEDED_API_CALLS', '1307': 'NOT_SUPPORTED_COUNTRY',
  '1308': 'NO_CONTROL_AUTHORITY', '1314': 'EXCEEDED_USER_API_CALLS',
  '2201': 'NOT_PROVIDED_FEATURE', '2214': 'FAIL_REQUEST', '2304': 'COMMAND_NOT_SUPPORTED_IN_POWER_OFF', '2208': 'FAIL_DEVICE_CONTROL',
};

export class ThinqError extends Error {
  constructor(code, message) {
    super(`ThinQ ${ERROR_NAMES[code] || 'ERROR'} (${code}): ${message}`);
    this.code = code;
  }
}

export class ThinqClient {
  constructor({ pat, country = 'US', clientId } = {}) {
    if (!pat) throw new Error('Missing PAT. Set LGAC_PAT in .env.');
    this.pat = pat;
    this.country = country.toUpperCase();
    this.clientId = clientId || crypto.randomUUID();
    this.region = regionFor(this.country);
    this.host = `api-${this.region}.lgthinq.com`;
    this.base = `https://${this.host}/`;
    this.calls = 0; // session API-call counter (surfaced in the TUI geek bar)
    this.lastPath = null; // last endpoint hit
    this.log = []; // rolling history of recent calls (newest first), full req/resp for the network tab
    this._seq = 0;
  }

  _push(entry) {
    this.lastPath = entry.path;
    this.log.unshift(entry);
    if (this.log.length > 40) this.log.pop();
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.pat}`,
      'x-country': this.country,
      'x-message-id': messageId(),
      'x-client-id': this.clientId,
      'x-api-key': API_KEY,
      'x-service-phase': 'OP',
      ...extra,
    };
  }

  async request(method, endpoint, { body, headers } = {}) {
    this.calls += 1;
    const reqHeaders = this.headers({ ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers });
    const url = this.base + endpoint;
    const entry = {
      id: ++this._seq,
      ts: Date.now(),
      method,
      path: `${method} /${endpoint.split('?')[0]}`,
      url,
      reqHeaders: redactHeaders(reqHeaders),
      reqBody: body ?? null,
      status: null,
      ok: null,
      code: null,
      ms: null,
      respBody: null,
    };
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method, headers: reqHeaders, body: body ? JSON.stringify(body) : undefined });
      entry.ms = Date.now() - t0;
      entry.status = res.status;
      const payload = await res.json().catch(() => ({}));
      entry.respBody = payload;
      if (!res.ok) {
        const err = payload.error || {};
        entry.ok = false;
        entry.code = err.code || String(res.status);
        this._push(entry);
        throw new ThinqError(err.code || String(res.status), err.message || res.statusText);
      }
      entry.ok = true;
      entry.code = res.status;
      this._push(entry);
      return payload.response;
    } catch (e) {
      if (entry.status == null) {
        entry.ms = Date.now() - t0;
        entry.ok = false;
        entry.code = 'NETERR';
        entry.respBody = { error: String(e.message) };
        this._push(entry);
      }
      throw e;
    }
  }

  // --- device endpoints (verified from thinq_api.py) ---
  listDevices() {
    return this.request('GET', 'devices');
  }
  getProfile(deviceId) {
    return this.request('GET', `devices/${deviceId}/profile`);
  }
  getState(deviceId) {
    return this.request('GET', `devices/${deviceId}/state`);
  }
  control(deviceId, payload) {
    return this.request('POST', `devices/${deviceId}/control`, {
      body: payload,
      headers: { 'x-conditional-control': 'true' },
    });
  }
  // Energy history (verified from connect_device.py): period DAILY (dates YYYYMMDD) or MONTHLY (YYYYMM);
  // `property` must be one of the names listed by getEnergyProfile(id).result.property.
  getEnergyProfile(deviceId) {
    return this.request('GET', `devices/energy/${deviceId}/profile`);
  }
  getEnergyUsage(deviceId, { property, period, startDate, endDate }) {
    const q = new URLSearchParams({ property, period, startDate, endDate });
    return this.request('GET', `devices/energy/${deviceId}/usage?${q}`);
  }

  // --- MQTT / event endpoints (verified from thinq_api.py + mqtt_client.py) ---
  getRoute() {
    return this.request('GET', 'route');
  }
  registerClient() {
    return this.request('POST', 'client', { body: CLIENT_BODY });
  }
  deregisterClient() {
    return this.request('DELETE', 'client', { body: CLIENT_BODY });
  }
  issueCertificate(csr) {
    return this.request('POST', 'client/certificate', { body: { 'service-code': 'SVC202', csr } });
  }
  subscribeEvent(deviceId) {
    return this.request('POST', `event/${deviceId}/subscribe`, { body: { expire: { unit: 'HOUR', timer: 4464 } } });
  }
  unsubscribeEvent(deviceId) {
    return this.request('DELETE', `event/${deviceId}/unsubscribe`);
  }
  listEventSubscriptions() {
    return this.request('GET', 'event');
  }
}

// Body LG's SDK sends to register an MQTT client (mqtt_client.py CLIENT_BODY).
const CLIENT_BODY = { type: 'MQTT', 'service-code': 'SVC202', 'device-type': '607', allowExist: true };

// Never expose the PAT / full api-key in the network-tab view.
function redactHeaders(h) {
  const out = { ...h };
  if (out.Authorization) out.Authorization = 'Bearer •••redacted•••';
  if (out['x-api-key']) out['x-api-key'] = `${out['x-api-key'].slice(0, 4)}…${out['x-api-key'].slice(-3)}`;
  return out;
}

// These units operate in Celsius on the wire (they reject unit:'F' writes with
// "2201 Not provided feature") but report both C and F in state. So: accept °F
// from the user, convert to the nearest valid 0.5°C step, clamp to the 16–30°C range.
export function fToC(f) {
  const c = Math.round(((f - 32) * 5) / 9 / 0.5) * 0.5;
  return Math.min(30, Math.max(16, c));
}
export const cToF = (c) => Math.round((c * 9) / 5 + 32);

// Region code -> human label (for the TUI infra bar).
export const REGION_LABEL = { aic: 'Americas', eic: 'Europe', kic: 'Asia/Pacific', mock: 'mock' };

// AC control payload builders (resources/props verified from air_conditioner.py
// and confirmed against live units).
export const ac = {
  power: (on) => ({ operation: { airConOperationMode: on ? 'POWER_ON' : 'POWER_OFF' } }),
  mode: (jobMode) => ({ airConJobMode: { currentJobMode: jobMode } }), // COOL, ENERGY_SAVING, AIR_DRY, FAN
  tempF: (f) => ({ temperature: { targetTemperature: fToC(f), unit: 'C' } }), // °F in, °C on the wire
  tempC: (t) => ({ temperature: { targetTemperature: t, unit: 'C' } }),
  fan: (strength) => ({ airFlow: { windStrength: strength } }), // LOW, MID, HIGH
  displayLight: (on) => ({ display: { light: on ? 'ON' : 'OFF' } }),
  powerSave: (on) => ({ powerSave: { powerSaveEnabled: !!on } }),
};

export function loadConfig(env = process.env) {
  return { pat: env.LGAC_PAT, country: env.LGAC_COUNTRY || 'US', clientId: env.LGAC_CLIENT_ID };
}
