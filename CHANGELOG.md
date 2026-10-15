# Changelog

## 0.3.0 — 2026-10-15

- Built-in tour: `?` in the TUI (13 steps, spotlights each region, live values) and `lgac tour`.
  It opens with why lgac subscribes to AWS IoT directly instead of polling. A first-run banner
  points at `?` until the tour has been opened once.
- Energy in the TUI: a today/month-to-date line in every panel and a fourth view with
  per-unit kWh (today, yesterday, 7d, month, 30d), a comparable 30-day sparkline per unit, the
  selected unit day by day, and an optional cost column from `LGAC_KWH_RATE`. One call per
  unit at startup, then only on `r`.
- Mock energy data now follows the real calendar (today/yesterday resolve on any day).
- `node-forge` removed: the one-time CSR is now built by hand on Node's crypto (verified with
  `openssl req -verify`). `npm audit` is clean.
- `lgac tui` opens the TUI (works from a global install).
- Full LG country → region table (previously a short US/EU/APAC subset).
- Open-source release prep: MIT license, contributing guide, CI, `bin` entry so `npm link` works.

## 0.2.0 — 2026-10-14

- MQTT: keep-alive 30s (AWS IoT's floor), exponential-backoff reconnect (3s→60s) with a
  live countdown on the MQTT tab, topic re-subscribe only when the session isn't resumed.
- `lgac energy [unit]`: daily/monthly Wh + kWh history with bars and a total.
- `status` shows setpoint range, set timers and non-NORMAL run state when reported.
- TUI renders in the alternate screen; `useWindowSize`; `d` simulates a drop in `--mock`.
- Deps: mqtt 5.16.1, ink 8 + react 19.3, commander 15; dotenv replaced by `process.loadEnvFile`;
  cert fingerprint via Node's `X509Certificate`. Node ≥ 22.12. `cache/mqtt.log` capped at 256 KB.

## 0.1.0 — 2026-07-23

- Initial release: ThinQ Connect REST client, `lgac` CLI, Ink TUI with live AWS IoT MQTT events,
  control confirmation from device events, network inspector, mock mode.
