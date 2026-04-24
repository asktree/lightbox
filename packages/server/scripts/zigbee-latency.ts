// Zigbee channel benchmarker.
//
// Fires N single-PUT brightness toggles at a target light, paced 1/sec so
// each PUT starts from a quiet bridge queue. Measures the HTTPS round-trip
// (TCP → bridge processing → Zigbee enqueue → response). A healthy channel
// lands ~40-120ms with low variance; a congested channel shows higher mean
// and/or much higher p95 / max (retries, Wi-Fi interference).
//
// Usage:
//   pnpm --filter @lightbox/server exec tsx scripts/zigbee-latency.ts \
//     --light "couch light actual" --count 30
//
// After running, manually change the Zigbee channel in the Hue app
// (Settings → Bridge → Zigbee Channel), wait ~60s for the mesh to settle,
// rerun. Append -o ~/zigbee.csv to accumulate a channel-by-channel report.
//
// Hue's recommended channels are 11, 15, 20, 25. These don't overlap each
// other and they do overlap different Wi-Fi channels — 15 and 20 are the
// most common "quiet" spots if your Wi-Fi is on 1/6/11.

import https from 'https';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../data/hue-config.json');

interface HueConfig { bridgeIp: string; username: string }

function cfg(): HueConfig {
  if (!existsSync(CONFIG_FILE)) throw new Error(`Hue config not found at ${CONFIG_FILE}`);
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });

function hue(method: 'GET' | 'PUT', path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const { bridgeIp, username } = cfg();
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = https.request({
      hostname: bridgeIp,
      path,
      method,
      agent,
      headers: {
        'hue-application-key': username,
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

async function getZigbeeChannel(): Promise<number | null> {
  // CLIP v1 exposes the Zigbee channel on the bridge's config resource.
  // CLIP v2 doesn't have a public channel field. Fall back to "unknown" if
  // the v1 endpoint is disabled on this bridge.
  try {
    const { username } = cfg();
    const res = await hue('GET', `/api/${username}/config`) as any;
    const ch = res.zigbeechannel ?? res.zigbeeChannel ?? null;
    return typeof ch === 'number' ? ch : null;
  } catch {
    return null;
  }
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
  throw new Error(`No light matching "${name}". Available: ` + (lightsRes.data || [])
    .map((l: any) => deviceName.get(l.owner?.rid) || l.metadata?.name).filter(Boolean).join(', '));
}

function stats(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const p = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n, min: sorted[0], max: sorted[n - 1],
    mean: Math.round(mean),
    p50: p(0.5), p95: p(0.95),
    stddev: Math.round(Math.sqrt(variance)),
  };
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function main() {
  const argv = process.argv.slice(2);
  let lightName = 'couch light actual';
  let count = 30;
  let intervalMs = 1000;
  let outFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--light' || a === '-l') lightName = argv[++i];
    else if (a === '--count' || a === '-n') count = Number(argv[++i]);
    else if (a === '--interval' || a === '-i') intervalMs = Number(argv[++i]);
    else if (a === '-o') outFile = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('zigbee-latency [--light NAME] [--count N] [--interval MS] [-o FILE]');
      process.exit(0);
    }
  }

  const channel = await getZigbeeChannel();
  const light = await findLight(lightName);
  console.log(`Target: "${light.name}" (${light.rid.slice(0, 8)})`);
  console.log(`Zigbee channel: ${channel ?? 'unknown (CLIP v1 /config unavailable)'}`);
  console.log(`Running ${count} PUTs, one every ${intervalMs}ms…`);

  const latencies: number[] = [];
  for (let i = 0; i < count; i++) {
    // Alternate brightness toggles so every PUT is a real state change.
    const bri = i % 2 === 0 ? 50 : 100;
    const t0 = Date.now();
    try {
      await hue('PUT', `/clip/v2/resource/light/${light.rid}`, {
        on: { on: true },
        dimming: { brightness: bri },
        dynamics: { duration: 0 },
      });
      const ms = Date.now() - t0;
      latencies.push(ms);
      process.stdout.write(`  ${String(i + 1).padStart(3)}/${count}  ${ms}ms\n`);
    } catch (e) {
      process.stdout.write(`  ${String(i + 1).padStart(3)}/${count}  ERROR ${e}\n`);
    }
    if (i < count - 1) await sleep(intervalMs);
  }

  const s = stats(latencies);
  console.log('\n== Results ==');
  console.log(`channel : ${channel ?? '?'}`);
  console.log(`n       : ${s.n}`);
  console.log(`min     : ${s.min} ms`);
  console.log(`mean    : ${s.mean} ms`);
  console.log(`p50     : ${s.p50} ms`);
  console.log(`p95     : ${s.p95} ms`);
  console.log(`max     : ${s.max} ms`);
  console.log(`stddev  : ${s.stddev} ms`);

  if (outFile) {
    const header = existsSync(outFile) ? '' : 'timestamp,channel,light,n,min,mean,p50,p95,max,stddev\n';
    const row = `${new Date().toISOString()},${channel ?? ''},"${light.name}",${s.n},${s.min},${s.mean},${s.p50},${s.p95},${s.max},${s.stddev}\n`;
    appendFileSync(outFile, header + row);
    console.log(`\nAppended to ${outFile}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
