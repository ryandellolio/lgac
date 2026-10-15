// The built-in tour: what every region of the TUI means and how the plumbing behind it works.
// Pure data so the TUI (`?` key) and the CLI (`lgac tour`) share one source of truth.
//
// Each step: { view, spot, title, body(ctx) } — `view` is the tab to show, `spot` names the
// region the TUI marks with ▶, and `body` returns lines with live values from `ctx`:
//   { host, region, regionLabel, calls, units, mock, conn, info, poll, rate, energyDays }
export const TOUR = [
  {
    view: 'dash',
    spot: 'header',
    title: 'Welcome — this is a live MQTT client, not just REST',
    body: () => [
      "REST (Node's fetch() to LG's ThinQ Connect API) covers the device list, state reads and controls. That's the small part.",
      'The big part: lgac is a full ThinQ push client. On start it registers itself with LG, generates an RSA key + CSR, has LG sign a client certificate, opens a mutual-TLS MQTT session to LG\'s AWS IoT broker with MQTT.js, and subscribes to your units\' event stream — the same channel the ThinQ phone app listens on.',
      'So the dashboard is LIVE: any change — from here, the app, the remote, a timer — arrives as the device\'s own event within a second or two, with zero polling (LG\'s per-user quota makes polling a non-starter). That same event confirms each control, timed. Tab 3 shows the session itself.',
    ],
  },
  {
    view: 'dash',
    spot: 'header',
    title: 'The header',
    body: (c) => [
      `The badge is the real health of the push channel, not just mock-vs-live: [LIVE] = subscribed to AWS IoT, [RECONNECTING] = dropped and backing off, [OFFLINE] = no MQTT. "${c.units}u" = units found · "${c.regionLabel}" = LG region (${c.host}).`,
      'Tabs: 1 Dashboard (control) · 2 Network (every REST call, devtools-style) · 3 MQTT (the live AWS IoT subscription) · 4 Energy (daily kWh per unit). Tab cycles.',
      "Nothing here is an SDK. It's Node's fetch against LG's REST API plus MQTT.js to AWS IoT — the wire contract worked out backwards from LG's own Python SDK source.",
    ],
  },
  {
    view: 'dash',
    spot: 'panel',
    title: 'One panel per unit',
    body: () => [
      'power / mode / set / now / fan come straight from GET /devices/{id}/state — or from an MQTT push. "set" shows °F / °C because these units run in Celsius on the wire (0.5° steps, 16–30°C) and reject unit:F writes; °F is display-only.',
      'Header glyph: ○ = online unknown (these units don\'t report it) · spinner = a control in flight · cyan ◀ = an MQTT push just landed (the border flashes green).',
      'Freshness bar drains over 2 minutes since the last push (local clock, 0 API calls). "mqtt" = age of the last push · "poll" = age of the last REST read — so you always know which channel last touched a unit.',
      '"energy" = today\'s kWh so far and this month to date, from LG\'s energy history (tab 4). LG updates today\'s total during the day; the row is a daily figure, not a live meter.',
    ],
  },
  {
    view: 'dash',
    spot: 'panel',
    title: 'Controls (dashboard keys)',
    body: () => [
      '←/→ pick a unit · ↑/↓ setpoint ±0.5°C · space power · m cycle mode (COOL → ENERGY_SAVING → AIR_DRY → FAN, read from the unit\'s own profile) · f fan LOW/MID/HIGH · a all units on/off (asks for y) · u refresh this unit (1 call) · r refresh all.',
      'Every control is exactly one API call: POST /devices/{id}/control (header x-conditional-control: true). Confirmation comes from the device\'s own MQTT event, not a follow-up GET.',
      'A control fires only on a keypress — never on startup, never on a code reload.',
    ],
  },
  {
    view: 'dash',
    spot: 'status',
    title: 'Status line',
    body: () => [
      'Narrates the current action with measured numbers, e.g. "set 21°C ✓ confirmed by MQTT event · POST 412ms · event +1830ms".',
      'Yellow = waiting for your y/n. Red = an LG error with its code + name — 1314 EXCEEDED_USER_API_CALLS means you hit the per-user quota; 2304 means the command isn\'t allowed while the unit is off.',
    ],
  },
  {
    view: 'dash',
    spot: 'pipeline',
    title: 'Control pipeline (honest by design)',
    body: () => [
      'Left node = the POST round-trip (measured). Right node = the device\'s MQTT event (measured: "+Nms" after the POST). The middle "transit" — LG cloud → AWS IoT → the unit\'s Wi-Fi — is invisible to us, so it\'s drawn as a comet that only shows motion, never a made-up percentage.',
      'If no event arrives within 8s it falls back to a single GET /state (turns yellow) and reports "applied" or "still syncing".',
    ],
  },
  {
    view: 'dash',
    spot: 'infra',
    title: 'Infra bar',
    body: (c) => [
      `"${c.host} · region ${c.region} · Bearer PAT · ${c.calls} calls this session". The PAT is a Personal Access Token from connect-pat.lgthinq.com (in .env, never shown).`,
      'The call counter matters: LG enforces a per-user quota. The device list and each unit\'s capability profile are cached on disk (cache/), so an idle TUI costs 0 calls — only state reads and controls spend. Opening the TUI = 2 calls per unit (one state read + one energy read).',
      c.poll ? `--poll ${c.poll}s is ON: that's ${Math.round((3600 / c.poll) * c.units)} extra calls per hour.` : 'No background polling (opt in with --poll <sec>); MQTT pushes keep it live for free.',
    ],
  },
  {
    view: 'dash',
    spot: 'flights',
    title: 'Control flight log',
    body: () => [
      'Every control you\'ve sent, newest first, with its full measured journey: POST ms · how it was confirmed (◀ device event, or ⚠ GET fallback) · whether it converged.',
      'The little drop animation above it "delivers" the newest flight from the pipeline into the record. Up to 50 are kept for the session.',
    ],
  },
  {
    view: 'energy',
    spot: 'energy',
    title: 'Energy tab — what each room actually burns',
    body: (c) => [
      `One row per unit from GET /devices/energy/{id}/usage?period=DAILY: today · yesterday · last 7 days · month to date · last ${c.energyDays} days, in kWh, plus a ${c.energyDays}-day sparkline scaled to the same max for every unit so rooms compare at a glance. Below it: the selected unit (←/→) day by day.`,
      'Limits: LG reports daily Wh totals — there is no live wattage in the API, so nothing here moves when you change a setpoint. LG does update today\'s total during the day (verified on real units), but how often is not documented; press r to refetch.',
      c.rate
        ? `Cost column = kWh × ${c.rate} (LGAC_KWH_RATE in .env). It's an estimate from your rate, not a bill.`
        : 'Set LGAC_KWH_RATE=<your price per kWh> in .env to add a cost column. Loaded once at startup (1 call per unit) and only again when you press r here — never on a timer.',
    ],
  },
  {
    view: 'net',
    spot: 'net',
    title: 'Network tab — a devtools inspector',
    body: () => [
      'Left: the last 40 REST calls (#, method, path, status, ms); red = failed. ↑/↓ selects. Right: the call\'s URL, request headers, request body and the full response JSON (j/k to scroll).',
      'Headers worth knowing: Authorization = your PAT (redacted here) · x-api-key = LG\'s PUBLIC constant baked into their SDK · x-message-id = 22-char random id per request · x-client-id = the fixed UUID from .env (also your MQTT client id) · x-country / x-service-phase.',
      'Open a GET …/profile response to see exactly what your units advertise (modes, fan speeds, temperature range + step). The UI renders from that — nothing is hardcoded.',
    ],
  },
  {
    view: 'mqtt',
    spot: 'mqtt-info',
    title: 'MQTT tab — how the live channel was built',
    body: (c) => [
      'Startup runs LG\'s handshake: POST /client (register) → GET /route (AWS IoT endpoint) → one-time RSA-2048 key + CSR signed by LG via POST /client/certificate (cached in cache/mqtt-cert.json) → mutual-TLS connect :8883 → SUBSCRIBE app/clients/<id>/push → POST /event/{id}/subscribe per unit.',
      `endpoint = the AWS IoT host · cert = your client cert's SHA-256 fingerprint${c.info?.certCached ? ' (cached — no re-issue)' : ''} · device subs = units subscribed · messages = pushes received · connected = uptime · reconnect = drops this session, or a live countdown while backing off (3s → 60s; keepalive 30s, the smallest AWS honors).`,
      `c tears the whole chain down and rebuilds it · x disconnects${c.mock ? ' · d simulates a dropped connection (mock only)' : ''}.`,
    ],
  },
  {
    view: 'mqtt',
    spot: 'mqtt-msgs',
    title: 'MQTT messages',
    body: () => [
      'Each push is summarized as "unit · what changed" (set/now temp, power, mode, fan). ↑/↓ selects; the right pane shows the raw JSON LG sent — the same event that confirmed your control in the pipeline.',
      'Pushes come from everywhere: this TUI, the ThinQ app, the physical remote, timers. That\'s why the dashboard stays live with zero polling.',
    ],
  },
  {
    view: 'dash',
    spot: 'footer',
    title: 'Quitting, cleanup & the CLI',
    body: () => [
      'q (or Ctrl-C) tears down in order: DELETE /event/{id}/unsubscribe per unit → MQTT disconnect → DELETE /client — then restores your terminal (alternate screen). After a hard kill, `lgac mqtt-cleanup` clears leftovers. Lifecycle is logged to cache/mqtt.log (capped at 256 KB).',
      'Same REST engine on the CLI, minus the MQTT channel — each command is one-shot and confirms a control with a single state read: lgac list · status · on/off · temp/tempc · mode · fan · all · energy (daily/monthly kWh) · sync · mqtt-status. `lgac tour` prints this tour. Add --mock to anything to run offline.',
      'That\'s the tour — press ? or Esc to close it any time.',
    ],
  },
];

// Plain-text rendering for the CLI.
export function renderTour(ctx, { color = (s) => s, dim = (s) => s, bold = (s) => s } = {}) {
  return TOUR.map((s, i) => {
    const head = bold(`${i + 1}/${TOUR.length}  ${s.title}`) + dim(`   [${s.view}]`);
    return [head, ...s.body(ctx).map((l) => '  ' + l)].join('\n');
  }).join('\n\n');
}
