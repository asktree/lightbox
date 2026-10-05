#!/usr/bin/env node
// OTA flash one box and put its routine back afterwards.
//   node scripts/ota.mjs couch1   (env couch1_ota, host couch1.local)
// Firmware boots with default params; the box has no persistent settings.
// So: GET /api/routine, flash, wait for the box, POST the saved routine.
import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';

const name = process.argv[2];
if (!name) { console.error('usage: ota.mjs <couch1|window>'); process.exit(2); }
const host = `${name}.local`;

async function ip() { return (await lookup(host, { family: 4 })).address; }
async function getRoutine() {
  const r = await fetch(`http://${await ip()}/api/routine`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`GET routine ${r.status}`);
  return r.json();
}
async function postRoutine(body) {
  const r = await fetch(`http://${await ip()}/api/routine`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`POST routine ${r.status}`);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let saved = null;
try { saved = await getRoutine(); console.log(`[ota] ${host} routine before:`, JSON.stringify(saved)); }
catch (e) { console.log(`[ota] ${host}: could not read routine (${e.message}); will not restore`); }

const pio = spawnSync('pio', ['run', '-e', `${name}_ota`, '-t', 'upload'], { stdio: 'inherit' });
if (pio.status !== 0) process.exit(pio.status ?? 1);

if (!saved) process.exit(0);
// Build the body the firmware accepts: rgb wins over hue when useRgb.
const body = { ...saved };
delete body.useRgb;
if (!saved.useRgb) delete body.rgb; else delete body.hue;

const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await sleep(3000);
  try {
    const now = await postRoutine(body);
    console.log(`[ota] ${host} routine restored:`, JSON.stringify(now));
    process.exit(0);
  } catch { /* still rebooting */ }
}
console.error(`[ota] ${host}: back online timeout; routine NOT restored`);
process.exit(1);
