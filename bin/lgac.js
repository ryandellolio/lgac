#!/usr/bin/env node
// lgac — control LG ThinQ window ACs from the terminal.
//   lgac list                    lgac temp 70 bedroom
//   lgac status living           lgac mode cool bedroom
//   lgac on office               lgac fan high living
//   lgac all off                 lgac sync   (refresh cached list/profiles)
//   lgac energy living           energy history (daily, last 30 days; --monthly, --from/--to)
// Add --mock to run against fixtures/ with no PAT. Add --fresh to bypass the cache.
//
// API-efficient by design: the device list and capability profiles are cached to disk
// (they don't change), so control commands cost 1 API call and only `list`/`status`/`watch`
// spend calls on live state. See "API usage" in the README.
import { Command } from 'commander';
import { ac, REGION_LABEL, loadConfig } from '../src/client.js';
import { renderTour } from '../src/tour.js';
import { makeClient, loadDevices, loadDevice, getDeviceList, resolveUnitId, getEnergyProperty, energyRows, ymd } from '../src/data.js';
import { clearCache, readCache } from '../src/cache.js';
import { row, detail, c } from '../src/format.js';

const program = new Command();
program
  .name('lgac')
  .description('Control LG ThinQ air conditioners over the official API')
  .option('--mock', 'use local fixture instead of the live API')
  .option('--fresh', 'bypass the disk cache and refetch list/profiles');

const opts = () => program.opts();
const client = () => makeClient({ mock: opts().mock });
const fresh = () => ({ fresh: !!opts().fresh });

function fail(msg) {
  console.error(c.red('error: ') + msg);
  process.exitCode = 1;
}

// Control one unit: resolve alias from the cached list (0 calls) + send control (1 call).
async function control(query, payload, label) {
  const cl = client();
  try {
    const id = await resolveUnitId(cl, query, fresh());
    if (!id) return fail(`No unit matches "${query || '(default)'}". Try: lgac list`);
    await cl.control(id, payload);
    console.log(c.green('✓ ') + `${query || id}: ${label}`);
  } catch (e) {
    fail(e.message);
  }
}

program
  .command('list')
  .description('list all units, one line each (1 state call per unit)')
  .action(async () => {
    try {
      const devices = await loadDevices(client(), fresh());
      if (!devices.length) return console.log('No devices found.');
      for (const d of devices) console.log(row(d));
    } catch (e) {
      fail(e.message);
    }
  });

program
  .command('status [unit]')
  .description('full state for one unit (1 state call)')
  .option('--json', 'raw state JSON')
  .option('--profile', 'raw capability profile JSON')
  .action(async (unit, cmd) => {
    const cl = client();
    try {
      const id = await resolveUnitId(cl, unit, fresh());
      if (!id) return fail(`No unit matches "${unit || '(default)'}". Try: lgac list`);
      const device = await loadDevice(cl, id, fresh());
      if (cmd.json) return console.log(JSON.stringify(device.state, null, 2));
      if (cmd.profile) return console.log(JSON.stringify(device.profile, null, 2));
      console.log(detail(device));
    } catch (e) {
      fail(e.message);
    }
  });

program.command('on [unit]').description('power on').action((u) => control(u, ac.power(true), 'powered ON'));
program.command('off [unit]').description('power off').action((u) => control(u, ac.power(false), 'powered OFF'));

program
  .command('temp <degreesF> [unit]')
  .description('set target temperature in °F (rounded to the nearest 0.5°C the unit supports)')
  .action((deg, u) => control(u, ac.tempF(Number(deg)), `target ${deg}°F`));

program
  .command('tempc <degreesC> [unit]')
  .description('set target temperature in °C (0.5° steps, 16–30 — the native granularity)')
  .action((deg, u) => control(u, ac.tempC(Number(deg)), `target ${deg}°C`));

program
  .command('mode <mode> [unit]')
  .description('set mode: cool | eco | dry | fan')
  .action((mode, u) => {
    const map = { cool: 'COOL', eco: 'ENERGY_SAVING', energy: 'ENERGY_SAVING', dry: 'AIR_DRY', fan: 'FAN' };
    control(u, ac.mode(map[mode.toLowerCase()] || mode.toUpperCase()), `mode ${map[mode.toLowerCase()] || mode.toUpperCase()}`);
  });

program
  .command('fan <speed> [unit]')
  .description('set fan: low | mid | high')
  .action((speed, u) => control(u, ac.fan(speed.toUpperCase()), `fan ${speed.toUpperCase()}`));

program
  .command('all <action> [value]')
  .description('apply to every unit: all off | all on | all temp 70 | all mode cool (1 call per unit)')
  .action(async (action, value) => {
    const cl = client();
    const build = {
      on: () => ac.power(true),
      off: () => ac.power(false),
      temp: () => ac.tempF(Number(value)),
      mode: () => ac.mode({ cool: 'COOL', eco: 'ENERGY_SAVING', energy: 'ENERGY_SAVING', dry: 'AIR_DRY', fan: 'FAN' }[value?.toLowerCase()] || String(value).toUpperCase()),
      fan: () => ac.fan(String(value).toUpperCase()),
    }[action];
    if (!build) return fail(`unknown action "${action}"`);
    try {
      const devices = await getDeviceList(cl, fresh()); // cached list, no state calls
      for (const d of devices) {
        try {
          await cl.control(d.id, build());
          console.log(c.green('✓ ') + `${d.alias}: ${action} ${value || ''}`.trim());
        } catch (e) {
          fail(`${d.alias}: ${e.message}`);
        }
      }
    } catch (e) {
      fail(e.message);
    }
  });

// Energy history — LG's devices/energy/{id}/usage. Period DAILY takes YYYYMMDD dates,
// MONTHLY takes YYYYMM (verified from the SDK's connect_device.py). The valid `property`
// names come from the unit's energy profile, which we fetch once and cache.
program
  .command('energy [unit]')
  .description('energy usage history (default: daily, last 30 days) — 1–2 API calls')
  .option('--monthly', 'monthly totals (default range: last 12 months)')
  .option('--from <date>', 'start date YYYYMMDD (or YYYYMM with --monthly)')
  .option('--to <date>', 'end date YYYYMMDD (or YYYYMM with --monthly), default today')
  .option('--property <name>', 'energy property (default: first one the unit reports)')
  .option('--json', 'raw response JSON')
  .action(async (unit, cmd) => {
    const cl = client();
    try {
      const id = await resolveUnitId(cl, unit, fresh());
      if (!id) return fail(`No unit matches "${unit || '(default)'}". Try: lgac list`);
      // Energy profile: which properties this unit can report. Static → cached (0 calls when warm).
      const prof = await getEnergyProperty(cl, id, { fresh: opts().fresh });
      const property = cmd.property || prof.property;
      if (!property) return fail(`unit reports no energy properties (profile: ${JSON.stringify(prof.profile)})`);
      const period = cmd.monthly ? 'MONTHLY' : 'DAILY';
      const now = new Date();
      const start = new Date(now);
      if (cmd.monthly) start.setMonth(start.getMonth() - 11);
      else start.setDate(start.getDate() - 29);
      const fmt = (d) => (cmd.monthly ? ymd(d).slice(0, 6) : ymd(d));
      const startDate = cmd.from || fmt(start);
      const endDate = cmd.to || fmt(now);
      const res = await cl.getEnergyUsage(id, { property, period, startDate, endDate });
      if (cmd.json) return console.log(JSON.stringify(res, null, 2));
      const alias = (await getDeviceList(cl, fresh())).find((d) => d.id === id)?.alias || id;
      console.log(c.bold(alias) + c.dim(` · ${property} · ${period.toLowerCase()} · ${startDate}→${endDate}`));
      console.log(energyTable(res, property));
    } catch (e) {
      fail(e.message);
    }
  });

// Live shape (confirmed 2026-10-14): { result: { dataList: [{ usedDate: 'YYYYMMDD', energyUsage: <Wh> }], property } }.
// Rendered as date · Wh · kWh · bar, with a total. Any other shape falls back to raw JSON.
function energyTable(res, property) {
  const rows = energyRows(res, property);
  if (!rows.length) return c.dim(JSON.stringify(res, null, 2));
  const max = Math.max(1, ...rows.map((r) => r.wh));
  let total = 0;
  const out = [c.dim(`${'date'.padEnd(10)} ${'Wh'.padStart(7)} ${'kWh'.padStart(7)}`)];
  for (const { date, wh } of rows) {
    total += wh;
    const bar = wh ? '▇'.repeat(Math.max(1, Math.round((wh / max) * 24))) : '';
    out.push(`${date.padEnd(10)} ${String(wh).padStart(7)} ${(wh / 1000).toFixed(2).padStart(7)}  ${wh ? c.cyan(bar) : c.dim('·')}`);
  }
  out.push(c.dim('total'.padEnd(10)) + ` ${c.bold(String(total).padStart(7))} ${c.bold((total / 1000).toFixed(2).padStart(7))}`);
  return out.join('\n');
}

// The TUI, so a global install has it: `lgac tui [--mock] [--poll <sec>]`. src/tui.js reads
// --mock/--poll from process.argv itself, so unknown options are allowed through untouched.
program
  .command('tui')
  .description('open the live TUI remote (--mock offline · --poll <sec> opt-in refresh)')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => import('../src/tui.js'));

program
  .command('tour')
  .description('explain every part of the TUI and the plumbing behind it (same tour as ? in the TUI; 0 API calls)')
  .action(() => {
    let host = 'api-aic.lgthinq.com', region = 'aic';
    try {
      const cl = client(); // builds the client only to read host/region — no requests
      host = cl.host;
      region = cl.region;
    } catch {
      region = { US: 'aic' }[loadConfig().country] || 'aic';
    }
    const units = readCache('devices.json')?.length ?? 3;
    const ctx = { host, region, regionLabel: REGION_LABEL[region] || region, calls: 'N', units, mock: !!opts().mock, conn: 'subscribed', info: { certCached: true }, poll: 0 };
    console.log(renderTour(ctx, { dim: c.dim, bold: c.bold }));
  });

program
  .command('sync')
  .description('refresh the cached device list + profiles (run after adding/renaming a unit)')
  .option('--clear', 'delete the cache entirely')
  .action(async (cmd) => {
    if (cmd.clear) {
      clearCache();
      return console.log('cache cleared.');
    }
    try {
      const devices = await loadDevices(client(), { fresh: true });
      console.log(c.green('✓ ') + `cached ${devices.length} unit(s) + profiles.`);
    } catch (e) {
      fail(e.message);
    }
  });

program
  .command('mqtt-status')
  .description('list active MQTT event subscriptions registered on the server')
  .action(async () => {
    try {
      console.log(JSON.stringify(await client().listEventSubscriptions(), null, 2));
    } catch (e) {
      fail(e.message);
    }
  });

program
  .command('mqtt-cleanup')
  .description('unsubscribe ALL device events + deregister this MQTT client (fixes leftovers after a hard kill)')
  .action(async () => {
    const cl = client();
    try {
      const list = await cl.listEventSubscriptions().catch(() => []);
      const arr = Array.isArray(list) ? list : list?.devices || list?.subscriptions || [];
      const ids = arr.map((x) => (typeof x === 'string' ? x : x.deviceId || x.id)).filter(Boolean);
      for (const id of ids) {
        await cl.unsubscribeEvent(id).then(
          () => console.log(c.green('✓ ') + `unsubscribed ${id}`),
          (e) => fail(`${id}: ${e.message}`)
        );
      }
      await cl.deregisterClient().catch(() => {});
      console.log(c.green('✓ ') + `deregistered MQTT client · cleaned ${ids.length} subscription(s)`);
    } catch (e) {
      fail(e.message);
    }
  });

program
  .command('watch [unit]')
  .description('poll and reprint state every N seconds (opt-in; spends calls continuously)')
  .option('-i, --interval <sec>', 'poll interval', '30')
  .action(async (unit, cmd) => {
    const cl = client();
    const secs = Math.max(10, Number(cmd.interval));
    console.log(c.dim(`polling every ${secs}s — Ctrl-C to stop`) + '\n');
    const tick = async () => {
      try {
        const devices = await loadDevices(cl);
        const id = unit ? await resolveUnitId(cl, unit) : null;
        const list = id ? devices.filter((d) => d.id === id) : devices;
        console.clear();
        console.log(c.dim(new Date().toLocaleTimeString()) + '\n');
        for (const d of list) console.log(row(d));
      } catch (e) {
        fail(e.message);
      }
    };
    await tick();
    setInterval(tick, secs * 1000);
  });

program.parseAsync().catch((e) => fail(e.message));
