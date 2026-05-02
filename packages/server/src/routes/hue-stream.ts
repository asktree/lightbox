import { Router } from 'express';
import { HueEntertainmentDriver } from '../drivers/hue-entertainment.js';
import { restFadedPulse, getRestLights, getMusicGroupRid, getMusicGroupLightNames, setRestMaxSockets, getRestMaxSockets, ridToLmId, getBridgeRttMs, getLightSnapshot, restoreLightSnapshot, type LightSnapshot } from '../drivers/hue-rest-pulse.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';

// Lazily constructed so a missing hue-config doesn't break server startup.
let driver: HueEntertainmentDriver | null = null;
function getDriver(): HueEntertainmentDriver {
  if (!driver) driver = new HueEntertainmentDriver();
  return driver;
}

export function createHueStreamRouter(paletteAnimator?: PaletteAnimator): Router {
  const r = Router();

  // Stream watchdog: musicbox heartbeats while it's the owner of the
  // stream. If no heartbeat lands for STREAM_HEARTBEAT_TIMEOUT_MS, we
  // tear the stream down. Closing the browser tab stops the heartbeat,
  // so the stream auto-shuts within ~10s instead of leaving bulbs stuck
  // in entertainment mode.
  let lastStreamHeartbeatMs = 0;
  // Generous timeout: backgrounded tabs get their setInterval throttled
  // (Chrome: 1Hz when hidden, sometimes worse). 60s gives a tabbed-away
  // client plenty of time to keep heartbeating without the stream dying.
  const STREAM_HEARTBEAT_TIMEOUT_MS = 60_000;
  setInterval(async () => {
    try {
      if (!driver?.active) return;
      if (lastStreamHeartbeatMs === 0) return; // no client has ever heartbeated; nothing to expire
      if (Date.now() - lastStreamHeartbeatMs < STREAM_HEARTBEAT_TIMEOUT_MS) return;
      console.log('[hue-stream] watchdog: no heartbeat for', STREAM_HEARTBEAT_TIMEOUT_MS / 1000, 's, stopping stream');
      lastStreamHeartbeatMs = 0;
      await driver.stop();
    } catch { /* ignore */ }
  }, 2000);

  // Cache of REST lights keyed by lowercased/trimmed name. Used by the
  // high-rate stream color loop below to avoid async work at 45Hz.
  let cachedRestLightsByName: Map<string, { rid: string; lmId: string; name: string }> | null = null;
  (async function initCache() {
    while (!cachedRestLightsByName) {
      try {
        const list = await getRestLights();
        const m = new Map<string, { rid: string; lmId: string; name: string }>();
        for (const l of list) m.set(l.name.trim().toLowerCase(), l);
        cachedRestLightsByName = m;
      } catch {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  })();

  // While the entertainment stream is active, continuously copy each
  // channel's palette color into its baseline. The stream frame pump at
  // 50Hz reads baseline × envelope, so baseline changes appear in the next
  // UDP frame. Runs at ~45Hz so chroma-driven palette overrides flow
  // through without perceptible lag.
  //
  // getPaletteColorForLight is a cheap in-memory computation (position
  // lookup + small HSV→RGB). No bridge traffic. At 45Hz × ~4 channels ≈
  // 180 fn calls/sec — trivial.
  setInterval(() => {
    try {
      if (!driver?.active || !paletteAnimator || !cachedRestLightsByName) return;
      for (const ch of driver.getChannels()) {
        const lm = cachedRestLightsByName.get(ch.lightName.trim().toLowerCase());
        if (!lm) continue;
        const color = paletteAnimator.getPaletteColorForLight(lm.lmId);
        if (color) driver.setChannel(ch.id, color.r, color.g, color.b);
      }
    } catch { /* ignore */ }
  }, 22);

  r.get('/state', (_req, res) => {
    try {
      const d = getDriver();
      res.json({ active: d.active, channels: d.getChannels() });
    } catch (err) {
      res.json({ active: false, channels: [], error: String(err) });
    }
  });

  // Body (optional): { lightNames?: string[], groupIntoSingleChannel?: boolean }
  r.post('/start', async (req, res) => {
    const { lightNames, groupIntoSingleChannel } = req.body ?? {};
    try {
      const d = getDriver();
      await d.start({
        lightNames: Array.isArray(lightNames) ? lightNames : null,
        groupIntoSingleChannel: !!groupIntoSingleChannel,
      });
      // Give the client a grace period to start heartbeating after start.
      lastStreamHeartbeatMs = Date.now();
      res.json({ active: d.active, channels: d.getChannels() });
    } catch (err) {
      console.error('hue-stream /start failed:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Body: { maxSockets }  — adjust REST keep-alive agent concurrency live.
  r.post('/rest-max-sockets', (req, res) => {
    const { maxSockets } = req.body ?? {};
    if (typeof maxSockets !== 'number') { res.status(400).json({ error: 'maxSockets required' }); return; }
    setRestMaxSockets(maxSockets);
    res.json({ maxSockets: getRestMaxSockets() });
  });
  r.get('/rest-max-sockets', (_req, res) => res.json({ maxSockets: getRestMaxSockets() }));

  // Source-agnostic bridge RTT. Any caller of restFadedPulse contributes —
  // musicbox rAF, autopilot, manual curl. Reflects real end-to-end pulse
  // time (attack + decay PUTs) EMA-smoothed.
  r.get('/bridge-rtt', (_req, res) => res.json({ bridge_rtt_ms: getBridgeRttMs() }));

  // Body: { hz }  — adjust stream frame rate live. Clamped to [5, 100].
  r.post('/frame-hz', (req, res) => {
    const { hz } = req.body ?? {};
    if (typeof hz !== 'number') { res.status(400).json({ error: 'hz required' }); return; }
    const d = getDriver();
    d.setFrameHz(hz);
    res.json({ hz: d.getFrameHz() });
  });
  r.get('/frame-hz', (_req, res) => {
    try { res.json({ hz: getDriver().getFrameHz() }); }
    catch { res.json({ hz: 50 }); }
  });

  r.post('/stop', async (_req, res) => {
    try {
      const d = getDriver();
      await d.stop();
      lastStreamHeartbeatMs = 0;
      res.json({ active: d.active });
    } catch (err) {
      console.error('hue-stream /stop failed:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Heartbeat from the client. While the stream is active and bindings
  // demand it, musicbox posts here every few seconds. If the post stops
  // (tab closed / page crashed / network drop), the watchdog above
  // tears the stream down so bulbs aren't stuck in entertainment mode.
  r.post('/heartbeat', (_req, res) => {
    lastStreamHeartbeatMs = Date.now();
    res.json({ ok: true });
  });

  // Body: { channelId?: number, r, g, b }  (omit channelId = all)
  r.post('/set', (req, res) => {
    const { channelId, r, g, b } = req.body ?? {};
    const d = getDriver();
    if (typeof channelId === 'number') d.setChannel(channelId, r, g, b);
    else d.setAll(r, g, b);
    res.json({ ok: true });
  });

  // Body: { channelId?: number, r, g, b, durationMs }
  r.post('/flash', (req, res) => {
    const { channelId, r, g, b, durationMs } = req.body ?? {};
    const d = getDriver();
    const dur = typeof durationMs === 'number' ? durationMs : 100;
    if (typeof channelId === 'number') d.flash(channelId, r, g, b, dur);
    else d.flashAll(r, g, b, dur);
    res.json({ ok: true });
  });

  // Body: { channelId?: number, r, g, b, attackMs, decayMs }
  r.post('/pulse', (req, res) => {
    const { channelId, r, g, b, attackMs, decayMs } = req.body ?? {};
    const d = getDriver();
    const a = typeof attackMs === 'number' ? attackMs : 30;
    const dc = typeof decayMs === 'number' ? decayMs : 600;
    if (typeof channelId === 'number') d.pulse(channelId, r, g, b, a, dc);
    else d.pulseAll(r, g, b, a, dc);
    res.json({ ok: true });
  });

  // Body: { channelId, peak, floor, attackMs, decayMs }
  // Uses the channel's current baseline color as the pulse color. peak/floor
  // are 0-100 (mapped to 0-1 brightness multipliers). After decay, holds at
  // `floor * baseline` until overwritten or cleared.
  r.post('/audio-pulse', (req, res) => {
    const { channelId, peak, floor, attackMs, decayMs } = req.body ?? {};
    if (typeof channelId !== 'number') { res.status(400).json({ error: 'channelId required' }); return; }
    const d = getDriver();
    d.audioPulse(
      channelId,
      (typeof peak === 'number' ? peak : 100) / 100,
      (typeof floor === 'number' ? floor : 10) / 100,
      typeof attackMs === 'number' ? attackMs : 20,
      typeof decayMs === 'number' ? decayMs : 400,
    );
    res.json({ ok: true });
  });

  // Body: { channelId }  — clear any effect on that channel (revert to baseline).
  r.post('/clear-effect', (req, res) => {
    const { channelId } = req.body ?? {};
    if (typeof channelId !== 'number') { res.status(400).json({ error: 'channelId required' }); return; }
    getDriver().clearEffect(channelId);
    res.json({ ok: true });
  });

  // Body: { channelId, level }  — level in [0,1]. Continuous brightness
  // multiplier against channel baseline. Call at client frame rate for
  // smooth level-tracking (energy, RMS, etc).
  const levelCalls = new Map<number, number>(); // channelId → call count
  r.post('/level', (req, res) => {
    const { channelId, level } = req.body ?? {};
    if (typeof channelId !== 'number' || typeof level !== 'number') {
      res.status(400).json({ error: 'channelId and level required' }); return;
    }
    getDriver().setLevel(channelId, level);
    const n = (levelCalls.get(channelId) ?? 0) + 1;
    levelCalls.set(channelId, n);
    if (n === 1 || n % 60 === 0) {
      console.log(`[hue-stream] /level ch=${channelId} n=${n} latest=${level.toFixed(3)}`);
    }
    res.json({ ok: true });
  });

  // Body: { r?, g?, b?, brightness?, decayMs?, lightId?, floor? }
  // Streaming must be stopped first (bridge ignores REST while a light is
  // part of an active entertainment configuration). Without lightId, pulses
  // the bridge_home group; with lightId, pulses that one bulb. If r/g/b are
  // omitted, the bulb flashes at its current color (useful for audio-reactive
  // pulsing where color is set elsewhere).
  r.post('/rest-pulse', async (req, res) => {
    const { r: R, g: G, b: B, brightness, decayMs, lightId, floor } = req.body ?? {};
    // If the light is pulse-claimed and the client didn't specify rgb, use
    // the palette's intended color for that light. Keeps claimed bulbs in
    // the palette's color story even though palette isn't writing to them.
    // lightId from client is a CLIP v2 rid; palette-animator keys on the
    // LightManager id (`hue:<v1>`) — translate before lookup.
    let rr = typeof R === 'number' ? R : undefined;
    let gg = typeof G === 'number' ? G : undefined;
    let bb = typeof B === 'number' ? B : undefined;
    if (rr === undefined && gg === undefined && bb === undefined && typeof lightId === 'string') {
      const lmId = lightId.startsWith('hue:') ? lightId : await ridToLmId(lightId);
      if (lmId && paletteAnimator?.isPulseClaimed(lmId)) {
        const c = paletteAnimator.getPaletteColorForLight(lmId);
        if (c) { rr = c.r; gg = c.g; bb = c.b; }
      }
    }
    try {
      await restFadedPulse({
        r: rr, g: gg, b: bb,
        peak: typeof brightness === 'number' ? brightness : 100,
        floor: typeof floor === 'number' ? floor : undefined,
        decayMs: typeof decayMs === 'number' ? decayMs : 400,
        lightId: typeof lightId === 'string' ? lightId : undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Pre-bind snapshots: when a light enters the claim set, capture its
  // brightness/on state so we can restore on unclaim. Keyed by rid
  // (CLIP v2 UUID) since that's what /light/{rid} PUTs want.
  const preBindSnapshots = new Map<string, LightSnapshot>();
  let activeClaimRids = new Set<string>();

  // Body: { lightIds: string[] }  — exclusive set of lights the music layer
  // is pulsing. Incoming ids are CLIP v2 rids (what /rest-pulse targets).
  // Translate to LightManager ids ("hue:<v1>") because palette-animator
  // keys on those (legacy). Send [] to release all claims.
  //
  // Side effect: new entries get their current state snapshotted; removed
  // entries get restored to what we captured on entry (so unbinding a
  // pulsed light returns it to whatever brightness it was before pulsing).
  r.post('/pulse-claim', async (req, res) => {
    const { lightIds } = req.body ?? {};
    if (!Array.isArray(lightIds)) { res.status(400).json({ error: 'lightIds array required' }); return; }
    const rids = lightIds.filter((x: any): x is string => typeof x === 'string');

    // Diff against current active set.
    const newSet = new Set(rids.filter(r => !r.startsWith('hue:'))); // only bare rids are snap-able
    const newlyClaimed = [...newSet].filter(r => !activeClaimRids.has(r));
    const newlyUnclaimed = [...activeClaimRids].filter(r => !newSet.has(r));

    // Snapshot before we start pulsing.
    for (const rid of newlyClaimed) {
      const snap = await getLightSnapshot(rid);
      if (snap) {
        preBindSnapshots.set(rid, snap);
        console.log(`[pulse-claim] snapshot ${rid.slice(0, 8)} brightness=${snap.brightness} on=${snap.on}`);
      }
    }

    // Restore on release.
    for (const rid of newlyUnclaimed) {
      const snap = preBindSnapshots.get(rid);
      if (snap) {
        try {
          await restoreLightSnapshot(rid, snap);
          console.log(`[pulse-claim] restored ${rid.slice(0, 8)} → brightness=${snap.brightness} on=${snap.on}`);
        } catch (e) {
          console.log(`[pulse-claim] restore failed for ${rid.slice(0, 8)}: ${e}`);
        }
        preBindSnapshots.delete(rid);
      }
    }
    activeClaimRids = newSet;

    // Convert rids → LightManager ids for the palette-animator exclusion set.
    const lmIds: string[] = [];
    for (const rid of rids) {
      if (rid.startsWith('hue:')) { lmIds.push(rid); continue; }
      const lm = await ridToLmId(rid);
      if (lm) lmIds.push(lm);
    }
    paletteAnimator?.setPulseClaim(lmIds);
    console.log(`[pulse-claim] claimed ${lmIds.length} lights: ${lmIds.join(', ') || '(none)'}`);
    res.json({ ok: true, claimed: lmIds });
  });

  // List color-capable lights for per-light REST pulse UI. Works without
  // the entertainment stream being active.
  r.get('/rest-lights', async (_req, res) => {
    try {
      const lights = await getRestLights();
      res.json({ lights });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Pulse the pre-defined music group (creates the Hue zone on first call).
  // Body: same as /rest-pulse minus lightId.
  r.post('/rest-pulse-music-group', async (req, res) => {
    const { r: R, g: G, b: B, brightness, decayMs, floor } = req.body ?? {};
    try {
      const groupRid = await getMusicGroupRid();
      await restFadedPulse({
        r: typeof R === 'number' ? R : undefined,
        g: typeof G === 'number' ? G : undefined,
        b: typeof B === 'number' ? B : undefined,
        peak: typeof brightness === 'number' ? brightness : 100,
        floor: typeof floor === 'number' ? floor : undefined,
        decayMs: typeof decayMs === 'number' ? decayMs : 400,
        groupRid,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('hue-stream /rest-pulse-music-group failed:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Names of the lights that belong to the pre-defined music group. Client
  // uses this to decide when "every bound light is firing this frame" and
  // can be coalesced into a single group pulse.
  r.get('/music-group-info', (_req, res) => {
    res.json({ names: getMusicGroupLightNames() });
  });

  // Body: { lightId: rid-or-lmId, position: 0-1 | null }
  // Sets a palette-position override for a light. The palette animator
  // uses this (TTL 1.5s) instead of the time-advanced position. Posting
  // null clears the override. Used by musicbox chroma→color bindings.
  r.post('/palette-position', async (req, res) => {
    const { lightId, position } = req.body ?? {};
    if (typeof lightId !== 'string') {
      return res.status(400).json({ error: 'lightId required' });
    }
    const lmId = lightId.startsWith('hue:') ? lightId : await ridToLmId(lightId);
    if (!lmId) {
      return res.status(404).json({ error: `no lm id for rid ${lightId}` });
    }
    if (position === null || position === undefined) {
      paletteAnimator?.clearPositionOverride(lmId);
    } else if (typeof position === 'number' && isFinite(position)) {
      paletteAnimator?.setPositionOverride(lmId, position);
    } else {
      return res.status(400).json({ error: 'position must be a number in [0,1] or null' });
    }
    res.json({ ok: true });
  });

  return r;
}
