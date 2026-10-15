// Live device events over AWS IoT Core (MQTT/mTLS), following LG's mqtt_client.py flow:
//   POST /client (register) → GET /route (endpoint) → generate keypair+CSR →
//   POST /client/certificate (issue cert + get topic) → connect mTLS :8883 →
//   SUBSCRIBE topic → POST /event/{id}/subscribe per device → receive pushes.
// Teardown reverses it. The issued cert/key is cached so we register+issue only once.
//
// makeEvents() returns a live client or an offline simulator (mock) with the same API,
// so the TUI's MQTT panel works with or without a PAT / network.
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { readCache, writeCache, appendCache } from './cache.js';

const ROOT_CA_URL = 'https://www.amazontrust.com/repository/AmazonRootCA1.pem';
const short = (id) => (id ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

// AWS IoT Core treats any keep-alive under 30s as 30s, so 30 is the smallest value the
// server actually honors (LG's SDK asks for 6, which just pings 5× more than needed).
const KEEPALIVE_S = 30;
// Our own reconnect schedule (MQTT.js only offers a fixed period): 3s, 6s, 12s … capped
// at 60s, with jitter. A 20-minute network/DNS blip then costs ~25 attempts, not 400.
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 60000;

export function makeEvents(client, cbs) {
  return client.mock ? new MockEvents(client, cbs) : new ThinqEvents(client, cbs);
}

// Shared shape for both implementations.
class BaseEvents {
  constructor(client, { onLog, onConn, onDevice, onEvent } = {}) {
    this.client = client;
    this.onLog = onLog || (() => {});
    this.onConn = onConn || (() => {});
    this.onDevice = onDevice || (() => {});
    this.onEvent = onEvent || (() => {});
    this.state = 'idle'; // idle|preparing|connecting|connected|subscribed|reconnecting|error|closed
    this.info = {
      endpoint: null, topic: null, certFp: null, certCached: false, subscriptions: [], deviceSubs: [],
      messages: 0, connectedAt: null, keepAlive: KEEPALIVE_S,
      drops: 0, attempt: 0, nextRetryAt: null, lastError: null, // reconnect bookkeeping
    };
    this.persist = false; // live client persists an audit log; the mock simulator does not
  }
  log(level, msg, extra) {
    const ts = Date.now();
    this.onLog({ ts, level, msg, extra });
    // Persist a durable audit trail (esp. teardown) so it survives process exit.
    if (this.persist && level !== 'event') {
      try {
        appendCache('mqtt.log', `${new Date(ts).toISOString()}  ${level.padEnd(5)} ${msg}\n`);
      } catch {}
    }
  }
  setState(s) {
    this.state = s;
    this.onConn(s, this.info);
  }
}

class ThinqEvents extends BaseEvents {
  persist = true; // write lifecycle (connect/subscribe/unsubscribe/disconnect) to cache/mqtt.log

  async start(deviceIds = []) {
    try {
      this.setState('preparing');
      this.log('info', 'POST /client — registering MQTT client (SVC202, device-type 607)…');
      await this.client.registerClient();

      this.log('info', 'GET /route — resolving AWS IoT endpoint…');
      const route = await this.client.getRoute();
      const endpoint = String(route?.mqttServer || '').replace(/^mqtts?:\/\//, '').split(':')[0];
      this.info.endpoint = endpoint;
      this.log('ok', `endpoint = ${endpoint}`);

      const { key, cert, ca, topic, subscriptions } = await this.ensureCertificate();
      this.info.topic = topic;
      this.info.subscriptions = subscriptions;
      this.info.certFp = fingerprint(cert);

      this.setState('connecting');
      this.log('info', `MQTT connect ${endpoint}:8883 (mTLS, clientId ${short(this.client.clientId)}, keepalive ${KEEPALIVE_S}s)…`);
      await this.connect({ endpoint, key, cert, ca });
      this.info.connectedAt = Date.now();
      this.setState('connected');

      await this.subscribeTopic(topic);
      this.setState('subscribed');

      for (const id of deviceIds) {
        this.log('info', `POST /event/${short(id)}/subscribe (expire 4464h)`);
        await this.client.subscribeEvent(id).catch((e) => this.log('warn', `event sub ${short(id)} failed: ${e.message}`));
      }
      this.info.deviceSubs = deviceIds;
      this.log('ok', `listening — ${deviceIds.length} device subscription(s) active`);
    } catch (e) {
      this.setState('error');
      this.log('error', e.message);
    }
  }

  async ensureCertificate() {
    const cached = readCache('mqtt-cert.json');
    if (cached?.cert && cached?.key && cached?.ca) {
      this.info.certCached = true;
      this.log('info', 'using cached client certificate (cache/mqtt-cert.json)');
      return cached;
    }
    this.log('info', 'generating RSA-2048 keypair (native) + CSR (CN=lg_thinq, SHA-512)…');
    const { privateKeyPem, csrBase64 } = makeCSR();
    this.log('info', 'GET AmazonRootCA1.pem…');
    const ca = await fetchRootCA();
    this.log('info', 'POST /client/certificate — issuing client cert from CSR…');
    const res = await this.client.issueCertificate(csrBase64);
    const cert = res?.result?.certificatePem;
    const subscriptions = res?.result?.subscriptions;
    if (!cert || !subscriptions?.length) throw new Error('certificate response missing certificatePem/subscriptions');
    const out = { key: privateKeyPem, cert, ca, topic: subscriptions[0], subscriptions };
    writeCache('mqtt-cert.json', out);
    this.log('ok', 'client certificate issued + cached');
    return out;
  }

  connect({ endpoint, key, cert, ca }) {
    return new Promise((resolve, reject) => {
      const c = mqtt.connect({
        host: endpoint,
        port: 8883,
        protocol: 'mqtts',
        key,
        cert,
        ca,
        clientId: this.client.clientId,
        clean: false,
        keepalive: KEEPALIVE_S,
        reconnectPeriod: 0, // we schedule reconnects ourselves (exponential backoff below)
        reconnectOnConnackError: true,
        rejectUnauthorized: true,
      });
      this.mqtt = c;
      let settled = false;
      c.on('connect', (connack) => {
        this.info.lastError = null;
        if (!settled) {
          this.log('ok', 'MQTT CONNACK — connected (mTLS)');
          settled = true;
          return resolve();
        }
        // Reconnected after a drop. A persistent session (clean:false) normally keeps our
        // subscription; if the broker says it didn't, subscribe again.
        const after = this.info.attempt;
        this.info.attempt = 0;
        this.info.nextRetryAt = null;
        this.info.connectedAt = Date.now();
        this.log('ok', `MQTT reconnected after ${after} attempt(s)${connack?.sessionPresent ? ' (session resumed)' : ' (new session)'}`);
        this.setState('connected');
        const done = () => this.setState('subscribed');
        if (connack?.sessionPresent || !this.info.topic) done();
        else this.subscribeTopic(this.info.topic).then(done, (e) => this.log('error', `re-subscribe failed: ${e.message}`));
      });
      c.on('close', () => {
        if (this.state === 'closed') return; // deliberate teardown
        this.log('warn', 'MQTT connection closed');
        this.scheduleReconnect();
      });
      c.on('error', (e) => {
        this.info.lastError = e.message;
        this.log('error', `MQTT error: ${e.message}`);
        if (!settled) reject(e);
      });
      c.on('message', (topic, buf) => this.onMessage(topic, buf));
      setTimeout(() => !settled && reject(new Error('MQTT connect timeout (15s)')), 15000);
    });
  }

  // Exponential backoff with jitter; one timer at a time; cancelled by stop().
  scheduleReconnect() {
    if (this._retryTimer || this.state === 'closed') return;
    if (this.info.attempt === 0) this.info.drops += 1;
    const n = this.info.attempt;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.info.attempt = n + 1;
    this.info.nextRetryAt = Date.now() + delay;
    this.setState('reconnecting');
    this.log('warn', `MQTT reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${n + 1})…`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this.state === 'closed') return;
      this.info.nextRetryAt = null;
      this.onConn(this.state, this.info);
      try {
        this.mqtt.reconnect();
      } catch (e) {
        this.log('error', `reconnect failed: ${e.message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  subscribeTopic(topic) {
    return new Promise((resolve, reject) => {
      this.mqtt.subscribe(topic, { qos: 1 }, (err) => {
        if (err) return reject(err);
        this.log('ok', `SUBSCRIBE ${topic} (QoS1)`);
        resolve();
      });
    });
  }

  onMessage(topic, buf) {
    this.info.messages += 1;
    let payload;
    try {
      payload = JSON.parse(buf.toString());
    } catch {
      payload = buf.toString();
    }
    this.onConn(this.state, this.info); // refresh the panel's message counter
    this.log('event', `◀ MQTT message on ${topic}`, payload);
    this.onEvent(payload);
    const deviceId = payload?.deviceId || payload?.data?.deviceId || payload?.pushType?.deviceId;
    const report = payload?.report || payload?.push || payload?.state || payload?.data?.state;
    if (deviceId && report && typeof report === 'object') this.onDevice(deviceId, report);
  }

  async stop() {
    this.setState('closed');
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this.log('info', 'teardown: starting');
    try {
      for (const id of this.info.deviceSubs) {
        await this.client.unsubscribeEvent(id).then(
          () => this.log('info', `DELETE /event/${short(id)}/unsubscribe`),
          (e) => this.log('warn', `unsubscribe ${short(id)}: ${e.message}`)
        );
      }
      if (this.mqtt) {
        if (this.info.topic && this.mqtt.connected) this.mqtt.unsubscribe(this.info.topic);
        this.mqtt.end(true);
        this.log('info', 'MQTT disconnected');
      }
      // LG occasionally answers DELETE /client with 2214 "Fail Request". It's transient and
      // harmless: the next start registers with allowExist:true. Not worth a warning.
      await this.client.deregisterClient().then(
        () => this.log('info', 'DELETE /client — deregistered'),
        (e) => this.log('info', `DELETE /client — ${e.message} (transient; `+ 'next start re-registers. If it persists: lgac mqtt-cleanup)')
      );
      this.log('ok', 'teardown complete');
    } catch (e) {
      this.log('warn', `teardown: ${e.message}`);
    }
  }
}

// Offline simulator: same interface, fake stages + synthetic device events on a timer.
class MockEvents extends BaseEvents {
  emitDeviceState(id) {
    const state = this.client._find?.(id)?.state;
    if (!state) return;
    const payload = { timestamp: Date.now(), deviceId: id, report: state, pushType: 'DEVICE_STATUS' };
    this.info.messages += 1;
    this.onConn(this.state, this.info);
    this.log('event', `◀ MQTT message (simulated) — ${short(id)} state change`, payload);
    this.onEvent(payload);
    this.onDevice(id, state);
  }

  async start(deviceIds = []) {
    this._ids = deviceIds;
    this._timers = [];
    this.client.onControl = (id) => this.emitDeviceState(id); // control -> confirming event
    const step = (ms, fn) => this._timers.push(setTimeout(fn, ms));
    this.setState('preparing');
    this.log('info', 'POST /client — registering (simulated)');
    step(250, () => {
      this.info.endpoint = 'a1b2c3d4e5-ats.iot.us-east-1.amazonaws.com';
      this.log('ok', `endpoint = ${this.info.endpoint} (simulated)`);
      this.info.certCached = true;
      this.info.certFp = 'de:ad:be:ef:12:34:56:78';
      this.info.topic = `app/clients/${short(this.client.clientId || 'mock-client')}/push`;
      this.info.subscriptions = [this.info.topic];
      this.setState('connecting');
    });
    step(600, () => {
      this.info.connectedAt = Date.now();
      this.setState('connected');
    });
    step(900, () => {
      this.log('ok', `SUBSCRIBE ${this.info.topic} (QoS1, simulated)`);
      this.info.deviceSubs = deviceIds;
      this.setState('subscribed');
      this.log('ok', `listening — ${deviceIds.length} device sub(s) (simulated)`);
    });
    // Emit a synthetic "device reported new state" event every few seconds.
    let n = 0;
    this._interval = setInterval(() => {
      if (!this._ids.length) return;
      const id = this._ids[n % this._ids.length];
      n += 1;
      const c = 20 + (n % 5) * 0.5;
      const report = {
        temperatureInUnits: [
          { unit: 'C', currentTemperature: c },
          { unit: 'F', currentTemperature: Math.round((c * 9) / 5 + 32) },
        ],
      };
      const payload = { timestamp: Date.now(), deviceId: id, report, pushType: 'DEVICE_STATUS' };
      this.info.messages += 1;
      this.onConn(this.state, this.info); // refresh the panel's message counter
      this.log('event', `◀ MQTT message (simulated) — ${short(id)} currentTemp ${c}°C`, payload);
      this.onEvent(payload);
      this.onDevice(id, report);
    }, 4000);
  }
  // Simulate a dropped connection + backoff so the reconnect UI can be exercised offline.
  simulateDrop() {
    if (this.state === 'closed') return;
    this.info.drops += 1;
    this.info.attempt = 1;
    this.info.nextRetryAt = Date.now() + 3000;
    this.log('warn', 'MQTT connection closed (simulated)');
    this.log('warn', 'MQTT reconnecting in 3.0s (attempt 1)… (simulated)');
    this.setState('reconnecting');
    this._timers.push(setTimeout(() => {
      if (this.state === 'closed') return;
      this.info.attempt = 0;
      this.info.nextRetryAt = null;
      this.info.connectedAt = Date.now();
      this.log('ok', 'MQTT reconnected after 1 attempt(s) (session resumed, simulated)');
      this.setState('subscribed');
    }, 3000));
  }
  async stop() {
    this.setState('closed');
    if (this.client) this.client.onControl = null;
    (this._timers || []).forEach(clearTimeout);
    clearInterval(this._interval);
    this.log('info', 'simulated teardown complete');
  }
}

// --- crypto helpers ---
// Node has no native CSR builder, so the one-time PKCS#10 request is assembled here by hand:
// a few DER primitives + the CertificationRequest structure (RFC 2986). Key generation and
// signing use Node's crypto. This replaced node-forge (an unfixable audit advisory in its
// signature-verification code, which we never used, but which showed up in every `npm audit`).
const der = {
  len: (n) => {
    if (n < 0x80) return Buffer.from([n]);
    const b = [];
    for (let v = n; v > 0; v >>= 8) b.unshift(v & 0xff);
    return Buffer.from([0x80 | b.length, ...b]);
  },
  tlv: (tag, body) => Buffer.concat([Buffer.from([tag]), der.len(body.length), body]),
  seq: (...items) => der.tlv(0x30, Buffer.concat(items)),
  set: (...items) => der.tlv(0x31, Buffer.concat(items)),
  int: (n) => der.tlv(0x02, Buffer.from([n])),
  null: () => Buffer.from([0x05, 0x00]),
  utf8: (s) => der.tlv(0x0c, Buffer.from(s, 'utf8')),
  bitstr: (b) => der.tlv(0x03, Buffer.concat([Buffer.from([0]), b])), // 0 unused bits
  ctx0: (body) => der.tlv(0xa0, body), // [0] IMPLICIT — the (empty) attributes set
  oid: (s) => {
    const p = s.split('.').map(Number);
    const bytes = [40 * p[0] + p[1]];
    for (const n of p.slice(2)) {
      const chunk = [n & 0x7f];
      for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
      bytes.push(...chunk);
    }
    return der.tlv(0x06, Buffer.from(bytes));
  },
};
const OID_COMMON_NAME = '2.5.4.3';
const OID_SHA512_RSA = '1.2.840.113549.1.1.13'; // sha512WithRSAEncryption

export function makeCSR({ commonName = 'lg_thinq' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  // CertificationRequestInfo ::= SEQUENCE { version 0, subject Name, SubjectPublicKeyInfo, [0] attributes }
  const info = der.seq(
    der.int(0),
    der.seq(der.set(der.seq(der.oid(OID_COMMON_NAME), der.utf8(commonName)))),
    publicKey.export({ type: 'spki', format: 'der' }),
    der.ctx0(Buffer.alloc(0))
  );
  const signature = crypto.sign('sha512', info, privateKey);
  // CertificationRequest ::= SEQUENCE { info, AlgorithmIdentifier, BIT STRING signature }
  const csrDer = der.seq(info, der.seq(der.oid(OID_SHA512_RSA), der.null()), der.bitstr(signature));
  return { privateKeyPem, csrBase64: csrDer.toString('base64') };
}

async function fetchRootCA() {
  const res = await fetch(ROOT_CA_URL);
  if (!res.ok) throw new Error(`root CA fetch failed: ${res.status}`);
  return res.text();
}

// First 8 bytes of the SHA-256 fingerprint, via Node's native X509 parser.
function fingerprint(certPem) {
  try {
    return new crypto.X509Certificate(certPem).fingerprint256.toLowerCase().split(':').slice(0, 8).join(':');
  } catch {
    return '?';
  }
}
