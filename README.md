# lgac

Control LG ThinQ air conditioners from the terminal. A CLI and a live TUI in plain Node.js,
built on LG's official [ThinQ Connect API](https://thinq.developer.lge.com/). No SDK, no
Python, no app-password scraping.

![lgac TUI: live dashboard, tour, energy and MQTT views](docs/demo.gif)

The TUI is more than a REST wrapper. It is a full ThinQ push client: it registers itself
with LG, obtains a client certificate, opens a mutual-TLS MQTT session to LG's AWS IoT broker
with [MQTT.js](https://github.com/mqttjs/MQTT.js), and subscribes to your units' event
stream, the same channel the ThinQ phone app listens on. Every change, whether from lgac,
the app, the physical remote, or a timer, lands in the terminal within a second or two, and
each command is confirmed by the device's own event rather than by polling. An idle session
spends zero API calls.

```
$ lgac list
● Living Room AC   ON    COOL   70°F / 21°C → 68°F / 20°C   fan LOW
● Bedroom AC       OFF   COOL   72°F / 22°C → 70°F / 21°C   fan LOW

$ lgac temp 70 bedroom
✓ bedroom: target 70°F

$ lgac energy living
date            Wh     kWh
20261002        79    0.08  ▇▇
20261003      1120    1.12  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇
total         5478    5.48
```

The TUI (`lgac tui`) shows one panel per unit, updates live from that MQTT stream, confirms
each command from the device's own event with measured timings, shows daily energy per unit,
and has a network inspector for every request plus a live view of the MQTT session itself.
Press `?` inside it for a tour; a banner under the header points this out until you have
taken it once.

## Install

Node.js 22.12 or newer.

```bash
git clone https://github.com/ryandellolio/lgac && cd lgac && npm install
npm link   # optional: puts `lgac` on your PATH
```

Not published to npm. Without `npm link`, run `node bin/lgac.js` in place of `lgac`.

Try it without a token: `lgac --mock list`, `lgac tui --mock`.

## Setup

1. Create a Personal Access Token at <https://connect-pat.lgthinq.com> with the device view
   and control scopes. The portal needs a native LG account (email + password); social logins
   don't work there (see Troubleshooting).
2. Copy [`.env.example`](.env.example) to `.env` in the directory you run lgac from:
   ```
   LGAC_PAT=...
   LGAC_COUNTRY=US          # ISO code of the LG account's country
   LGAC_CLIENT_ID=...       # any UUID; generate once and keep it
   LGAC_KWH_RATE=0.18       # optional: your price per kWh, for the TUI's cost column
   ```
3. `lgac list`, then `lgac sync` once to cache the device list and capability profiles.

The token stays in `.env` and is redacted anywhere the tool prints headers.

## CLI

```
lgac list                    one line per unit
lgac status [unit]           full state   (--json · --profile)
lgac on | off [unit]
lgac temp <°F> [unit]        rounded to the unit's native 0.5 °C step
lgac tempc <°C> [unit]
lgac mode cool|eco|dry|fan [unit]
lgac fan low|mid|high [unit]
lgac all off|on|temp 70|mode cool|fan high
lgac energy [unit]           daily Wh/kWh, last 30 days  (--monthly · --from/--to · --json)
lgac watch [unit] -i 30      poll and reprint
lgac sync [--clear]          refresh or wipe the cache
lgac tui                     the live TUI  (--mock · --poll <sec>)
lgac tour                    the TUI tour, as text
lgac mqtt-status             server-side event subscriptions
lgac mqtt-cleanup            remove them after a hard kill
```

The CLI is REST only. Each command is a one-shot request and exits; it never opens the MQTT
channel. After a control it reads that unit's state back once to confirm. `mqtt-status`
and `mqtt-cleanup` are REST calls about the server-side event subscriptions, not MQTT
connections. The live channel is a TUI thing.

`[unit]` matches an alias substring or id; omit it for the first unit. `--mock` runs any
command offline; `--fresh` bypasses the cache once.

## TUI

```bash
lgac tui [--mock] [--poll <sec>]
```

Four views (`Tab`, or `1`–`4`): the dashboard, a network inspector, the MQTT session, and
energy. Dashboard keys: `←/→` unit · `↑/↓` setpoint · `space` power · `m` mode · `f` fan ·
`a` all on/off · `u`/`r` refresh one/all · `?` tour · `q` quit.

Each panel shows today's kWh so far and the month to date. The Energy view has one row per
unit (today · yesterday · 7 days · month to date · 30 days, with a 30-day sparkline) and the
selected unit day by day. Set `LGAC_KWH_RATE` in `.env` to your price per kWh for a cost
column. LG reports daily totals and updates today's during the day; there is no live wattage
in the API. Energy loads once at startup (one call per unit) and again only when you press
`r` on that view.

The TUI never sends a command on startup. Quitting unsubscribes and deregisters the MQTT
client. Dropped connections reconnect with backoff.

## API usage

LG rate-limits per user (`1314 EXCEEDED_USER_API_CALLS`), and a naive dashboard that polls
each unit every few seconds blows through that quota in about an hour. lgac's usage is low
because of the MQTT subscription: once the push channel is up, state changes arrive as
events, so the TUI never polls. An open, idle TUI makes zero API calls no matter how long it
runs, and a command is confirmed by the device's own event rather than a follow-up read.

On top of that, the device list and capability profiles are cached on disk, state is read
only when you ask, and each control is exactly one request. Opening the TUI costs two calls
per unit (state and 30 days of energy history); after that only your own actions spend
calls: one per control, one per `u`, one per unit for `r`.

## How it works

- `src/client.js` — the REST contract: headers, endpoints, error codes, control payloads.
  Everything traces to LG's published Python SDK.
- `src/data.js` — caching and the mock client.
- `src/mqtt.js` — the push client: register with LG, fetch the AWS IoT route, generate an
  RSA key and CSR, have LG sign it, connect over mutual TLS with MQTT.js, subscribe to
  `app/clients/<id>/push`, subscribe each unit's events, and reconnect with backoff.
- `src/tui.js`, `src/tour.js`, `src/format.js` — the Ink UI.


## Why Node

LG ships an official Python SDK, and the sensible thing would have been to use it. I wanted
to build this in Node for fun. So the protocol here is not original research: the headers,
endpoints, error codes and the MQTT certificate handshake were worked out backwards from the
SDK's source and reimplemented on `fetch` and MQTT.js, including the whole MQTT
registration and certificate dance. Credit for figuring out how ThinQ
Connect actually works belongs to LG's SDK authors.

## Compatibility

Any air conditioner that shows up in the LG ThinQ app should work: the API reports it as
`DEVICE_AIR_CONDITIONER` and lgac renders from the unit's own capability profile.

- **Tested:** LG LW1022IVSM — 10,000 BTU Dual Inverter smart window AC, 115V (API model
  `WIN_056905_WW`). Three units, daily use since July 2026.
- **Same series, untested:** LW8022IVSM (8,000 BTU), LW1222IVSM (12,000), LW1522IVSM (14,000),
  LW1822IVSM (18,000, 230V). Same ThinQ platform; expected to work as-is.
- **Other ThinQ ACs** (portables, mini-splits with the Wi-Fi module): the modes, fan speeds and
  temperature range come from the profile, so the UI adapts. Extras like swing, air quality
  sensors or energy-save show up in `status` when the unit reports them. If something is missing,
  open an issue with `lgac status <unit> --profile`.

## Troubleshooting

When LG's API rejects a request, lgac prints LG's error code and its name, for example:

```
error: ThinQ EXCEEDED_USER_API_CALLS (1314): ...
```

The ones you're likely to see:

| Code | Name | Meaning | What to do |
|---|---|---|---|
| 1103 | INVALID_TOKEN | The PAT is wrong, expired, or missing scopes | Make a new token at connect-pat.lgthinq.com with device view + control |
| 1307 | NOT_SUPPORTED_COUNTRY | `LGAC_COUNTRY` doesn't match the account | Use the ISO code of the country the LG account is registered in |
| 1314 | EXCEEDED_USER_API_CALLS | You hit LG's per-user rate limit | Wait. It resets on its own. Avoid `watch` with short intervals; use `--mock` for development |
| 2201 | NOT_PROVIDED_FEATURE | The unit doesn't support that setting | For example these units reject writes in °F; lgac already sends °C |
| 2304 | COMMAND_NOT_SUPPORTED_IN_POWER_OFF | That command needs the unit on | `lgac on <unit>` first |

Other things:

- **"Login Failed" on the token site** — the portal doesn't accept Google/Apple/Facebook/Amazon
  sign-in. Use a native LG account (email + password) that owns the devices.
- **`Unsupported country "XX"`** (from lgac, not LG) — `LGAC_COUNTRY` isn't in LG's country list.
- **Can't log in to the PAT portal** — the most common snag. The portal only accepts a native LG
  account (email + password); if your ThinQ account was created through Google, Apple, Facebook
  or Amazon, make an LG account and move the units to it. "Country not supported" means the
  account's home country isn't a ThinQ Connect country. A blank page means the site's JavaScript
  was blocked; try another browser or disable blockers.
- **The TUI says RECONNECTING** — AWS drops idle MQTT connections from time to time. lgac
  reconnects on its own with increasing delays; the MQTT tab shows the countdown.
- **Stale subscriptions after a crash** — `lgac mqtt-cleanup` removes them from LG's side.

## Built with AI

Written with Claude Code, reviewed and tested by a human on real hardware.

## License

[MIT](LICENSE). Not affiliated with LG Electronics.
