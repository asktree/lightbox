// Cycle through all Zigbee channels, run a benchmark on each, and emit a
// comparison report. Each channel change disrupts the mesh for ~30-45s
// while bulbs rejoin — the script waits before benchmarking.
//
// Usage:
//   pnpm --filter @lightbox/server exec tsx scripts/zigbee-sweep.ts \
//     --light "couch light actual"
//
// Flags:
//   --light NAME   target light (default: couch light actual)
//   --count N      samples per channel (default 30)
//   --settle MS    wait after channel switch (default 45000)
//   --only 11,20   limit to specific channels
//   --restore 20   channel to switch back to at the end (default: starting channel)

import https from 'https';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../data/hue-config.json');
const HUE_CHANNELS = [11, 15, 20, 25];

interface HueConfig { bridgeIp: string; username: string }
const cfg: HueConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });

function hue(method: 'GET' | 'PUT', path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = https.request({
      hostname: cfg.bridgeIp, path, method, agent,
      headers: {
        'hue-application-key': cfg.username,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if ((res.statusCode ?? 0) >= 400) reject(new Error(`${method} ${path} → ${res.statusCode}: ${data.slice(0, 200)}`));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getChannel(): Promise<number | null> {
  try {
    const res = await hue('GET', `/api/${cfg.username}/config`) as any;
    return res.zigbeechannel ?? null;
  } catch { return null; }
}

async function setChannel(ch: number): Promise<void> {
  await hue('PUT', `/api/${cfg.username}/config`, { zigbeechannel: ch });
}

async function findLight(name: string): Promise<{ rid: string; name: string }> {
  const [lightsRes, devicesRes] = await Promise.all([
    hue('GET', '/clip/v2/resource/light'),
    hue('GET', '/clip/v2/resource/device'),
  ]);
  const deviceName = new Map<string, string>();
  for (const d of devicesRes.data || []) if (d?.id && d?.metadata?.name) deviceName.set(d.id, d.metadata.name);
  const target = name.trim().toLowerCase();
  for (const l of lightsRes.data || []) {
    const n = (deviceName.get(l.owner?.rid) || l.metadata?.name || '').trim().toLowerCase();
    if (n === target) return { rid: l.id, name: deviceName.get(l.owner?.rid) || l.metadata?.name || '' };
  }
  throw new Error(`No light matching "${name}"`);
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const p = (q: number) => s[Math.min(n - 1, Math.floor(q * (n - 1)))];
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { n, min: s[0], max: s[n - 1], mean: Math.round(mean), p50: p(0.5), p95: p(0.95), stddev: Math.round(Math.sqrt(variance)) };
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function bench(lightRid: string, count: number): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < count; i++) {
    const bri = i % 2 === 0 ? 50 : 100;
    const t0 = Date.now();
    try {
      await hue('PUT', `/clip/v2/resource/light/${lightRid}`, {
        on: { on: true }, dimming: { brightness: bri }, dynamics: { duration: 0 },
      });
      latencies.push(Date.now() - t0);
    } catch (e) {
      process.stdout.write(` ERR`);
    }
    process.stdout.write('.');
    if (i < count - 1) await sleep(1000);
  }
  process.stdout.write('\n');
  return latencies;
}

async function main() {
  const argv = process.argv.slice(2);
  let lightName = 'couch light actual';
  let count = 30;
  let settleMs = 45000;
  let only: number[] | null = null;
  let restore: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--light' || a === '-l') lightName = argv[++i];
    else if (a === '--count' || a === '-n') count = +argv[++i];
    else if (a === '--settle') settleMs = +argv[++i];
    else if (a === '--only') only = argv[++i].split(',').map(Number);
    else if (a === '--restore') restore = +argv[++i];
  }

  const startChannel = await getChannel();
  if (restore === null) restore = startChannel ?? 20;
  const light = await findLight(lightName);
  const channels = only ?? HUE_CHANNELS;

  console.log(`Target: "${light.name}"`);
  console.log(`Starting channel: ${startChannel ?? '?'}`);
  console.log(`Plan: test ${channels.join(', ')} (${count} samples each), restore to ${restore}`);
  console.log('');

  const results: Array<{ channel: number; s: ReturnType<typeof stats> | null; error?: string }> = [];
  for (const ch of channels) {
    const cur = await getChannel();
    if (cur !== ch) {
      console.log(`→ switching to channel ${ch} (settle ${settleMs}ms)…`);
      try {
        await setChannel(ch);
      } catch (e) {
        console.log(`  switch failed: ${e}`);
        results.push({ channel: ch, s: null, error: String(e) });
        continue;
      }
      await sleep(settleMs);
    } else {
      console.log(`→ already on channel ${ch}, short settle (5s)…`);
      await sleep(5000);
    }
    const verify = await getChannel();
    process.stdout.write(`   channel ${verify ?? '?'}  benchmarking`);
    const lats = await bench(light.rid, count);
    if (lats.length === 0) {
      results.push({ channel: ch, s: null, error: 'no successful samples' });
      continue;
    }
    const s = stats(lats);
    results.push({ channel: ch, s });
    console.log(`   n=${s.n}  min=${s.min}  mean=${s.mean}  p50=${s.p50}  p95=${s.p95}  max=${s.max}  stddev=${s.stddev}`);
    console.log('');
  }

  console.log(`→ restoring channel ${restore}…`);
  try { await setChannel(restore); await sleep(settleMs); } catch (e) { console.log(`  restore failed: ${e}`); }

  console.log('\n================= Summary =================');
  console.log('channel  n   min  mean  p50  p95  max  stddev');
  for (const r of results) {
    if (!r.s) { console.log(`${String(r.channel).padStart(7)}  -- ${r.error ?? 'failed'}`); continue; }
    const pad = (v: number) => String(v).padStart(4);
    console.log(`${String(r.channel).padStart(7)}  ${pad(r.s.n)}  ${pad(r.s.min)}  ${pad(r.s.mean)}  ${pad(r.s.p50)}  ${pad(r.s.p95)}  ${pad(r.s.max)}  ${pad(r.s.stddev)}`);
  }

  const outPath = '/tmp/zigbee-sweep.json';
  writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), lightName: light.name, results }, null, 2));
  console.log(`\nFull results: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
