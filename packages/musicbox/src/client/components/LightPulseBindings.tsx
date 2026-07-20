import { useEffect, useMemo, useRef, useState } from 'react';
import type { MadmomOnsets } from './OnsetTimeline';

// Bind Hue lights to audio sources. Source type determines transport:
//   peak (onsets)       → REST  (attack + decay PUT per peak crossing)
//   energy (continuous) → DTLS entertainment stream (/level per rAF tick)
//
// The stream is started/stopped/reconfigured automatically based on which
// lights currently have an energy binding. Light rids are the unit of
// binding; when a light needs to participate in the stream, its name is
// added to the dedicated entertainment configuration.

const LIGHTBOX_URL = `http://${window.location.hostname}:3001`;

// Only surface these lights in the UI. Non-Hue lights (WiZ, Tuya) are
// loaded separately and joined into the same list. Energy bindings dispatch
// per-brand: Hue → entertainment stream, WiZ → UDP setPilot, Tuya → REST
// setState (which coalesces per-device against the persistent connection).
const ALLOWED_LIGHT_NAMES = ['couch light actual', 'hue iris 1', 'spaceship floor', 'cockpit', 'gu10 kitchen', 'sunvie gu10 couch'];

// rid prefix marks a non-Hue light. Hue rids are bare CLIP v2 UUIDs.
const isWizRid  = (rid: string) => rid.startsWith('wiz:');
const isTuyaRid = (rid: string) => rid.startsWith('tuya:');

// Pinned to the top of the dropdown and used by the "all →" button.
const DEFAULT_SOURCE_KEY = 'drums_low_strict.sf';

type Stem = 'drums' | 'bass' | 'vocals' | 'other';

type PeakSourceDef = {
  kind: 'peak';
  key: string;
  label: string;
  path: [keyof MadmomOnsets, 'cnn' | 'superflux'];
};
// `stems` is summed (additive, NOT averaged) so combined sources like
// "bass+drums" are punchier than either alone — they exceed the per-stem
// peak when both fire together, then get clamped to 1 after gain scaling.
type EnergySourceDef = { kind: 'energy'; key: string; label: string; stems: Stem[] };
type SourceDef = PeakSourceDef | EnergySourceDef;

const PEAK_SOURCES: PeakSourceDef[] = [
  { kind: 'peak', key: 'drums_low_strict.sf',    label: 'drums_low_strict · sf',   path: ['drums_low_strict', 'superflux'] },
  { kind: 'peak', key: 'bass_strict.sf',         label: 'bass_strict · sf',        path: ['bass_strict', 'superflux'] },
  { kind: 'peak', key: 'drums_low.sf',           label: 'drums_low · sf',          path: ['drums_low', 'superflux'] },
  { kind: 'peak', key: 'drums_low.cnn',          label: 'drums_low · cnn',         path: ['drums_low', 'cnn'] },
  { kind: 'peak', key: 'drums_low_strict.cnn',   label: 'drums_low_strict · cnn',  path: ['drums_low_strict', 'cnn'] },
  { kind: 'peak', key: 'drums_mid.cnn',          label: 'drums_mid · cnn',         path: ['drums_mid', 'cnn'] },
  { kind: 'peak', key: 'drums_mid.sf',           label: 'drums_mid · sf',          path: ['drums_mid', 'superflux'] },
  { kind: 'peak', key: 'drums_mid_strict.cnn',   label: 'drums_mid_strict · cnn',  path: ['drums_mid_strict', 'cnn'] },
  { kind: 'peak', key: 'drums_mid_strict.sf',    label: 'drums_mid_strict · sf',   path: ['drums_mid_strict', 'superflux'] },
  { kind: 'peak', key: 'drums_high.cnn',         label: 'drums_high · cnn',        path: ['drums_high', 'cnn'] },
  { kind: 'peak', key: 'drums_high.sf',          label: 'drums_high · sf',         path: ['drums_high', 'superflux'] },
  { kind: 'peak', key: 'drums_high_strict.cnn',  label: 'drums_high_strict · cnn', path: ['drums_high_strict', 'cnn'] },
  { kind: 'peak', key: 'drums_high_strict.sf',   label: 'drums_high_strict · sf',  path: ['drums_high_strict', 'superflux'] },
  { kind: 'peak', key: 'drums.cnn',              label: 'drums · cnn',             path: ['drums', 'cnn'] },
  { kind: 'peak', key: 'drums.sf',               label: 'drums · sf',              path: ['drums', 'superflux'] },
  { kind: 'peak', key: 'drums_strict.cnn',       label: 'drums_strict · cnn',      path: ['drums_strict', 'cnn'] },
  { kind: 'peak', key: 'drums_strict.sf',        label: 'drums_strict · sf',       path: ['drums_strict', 'superflux'] },
  { kind: 'peak', key: 'non_drums.cnn',          label: 'non_drums · cnn',         path: ['non_drums', 'cnn'] },
  { kind: 'peak', key: 'non_drums.sf',           label: 'non_drums · sf',          path: ['non_drums', 'superflux'] },
  { kind: 'peak', key: 'non_drums_strict.cnn',   label: 'non_drums_strict · cnn',  path: ['non_drums_strict', 'cnn'] },
  { kind: 'peak', key: 'non_drums_strict.sf',    label: 'non_drums_strict · sf',   path: ['non_drums_strict', 'superflux'] },
  { kind: 'peak', key: 'full.cnn',               label: 'full · cnn',              path: ['full', 'cnn'] },
  { kind: 'peak', key: 'full.sf',                label: 'full · sf',               path: ['full', 'superflux'] },
];
const ENERGY_SOURCES: EnergySourceDef[] = [
  { kind: 'energy', key: 'bass.energy',         label: 'bass · energy',         stems: ['bass'] },
  { kind: 'energy', key: 'drums.energy',        label: 'drums · energy',        stems: ['drums'] },
  { kind: 'energy', key: 'vocals.energy',       label: 'vocals · energy',       stems: ['vocals'] },
  { kind: 'energy', key: 'other.energy',        label: 'other · energy',        stems: ['other'] },
  { kind: 'energy', key: 'bass+drums.energy',   label: 'bass+drums · energy',   stems: ['bass', 'drums'] },
  { kind: 'energy', key: 'other+vocals.energy', label: 'other+vocals · energy', stems: ['other', 'vocals'] },
];
const ALL_SOURCES: SourceDef[] = [...PEAK_SOURCES, ...ENERGY_SOURCES];
const SOURCE_BY_KEY = new Map(ALL_SOURCES.map(s => [s.key, s] as const));

interface LightOption { rid: string; name: string }
interface StreamChannel { id: number; lightName: string }
interface StreamStateResp { active: boolean; channels: StreamChannel[]; error?: string }

// Color source for a light's palette position. 'palette' = normal time-driven
// progression from the palette animator. Anything else = map the named stem's
// chroma (spectral centroid, 0-1) directly to palette position via an
// override the animator respects.
type ColorSource = 'palette' | `${Stem}.chroma`;

interface Binding {
  sourceKey: string | null;
  peak: number;    // 1-100 — attack brightness for peaks, max level for energy
  floor: number;   // 1-100 — decay target for peaks, min level for energy
  decayMs: number; // peak only
  // (energy bindings used to have a `gain` multiplier here; removed once
  // stemEnergyRef went percentile-mapped, since the input is already in
  // [0,1] and gain became redundant with floor/peak. Lingering `gain`
  // fields on persisted bindings are harmless — they're just ignored.)
  // Asymmetric envelope follower (energy mode). attackSmooth gates how fast
  // brightness rises when raw energy increases; decaySmooth gates how fast
  // it falls. 0 = no smoothing (instant), closer to 1 = heavy smoothing.
  // Default fast-attack/slow-decay gives the classic "punch with tail" feel.
  attackSmooth: number;
  decaySmooth: number;
  chromaSmooth: number; // chroma smoothing — EMA alpha (0-0.99), chroma color
  colorSource: ColorSource; // how the palette position for this light is decided
  // Energy normalization mode. 'percentile' = empirical-CDF rank (current
  // default, song-average ≈ 50%); 'robust-minmax' = (raw − p2)/(p98 − p2)
  // clipped, which maps silent stretches to 0 cleanly. App.tsx writes both
  // refs every rAF tick; we pick at read time.
  normMode?: 'percentile' | 'robust-minmax';
}
function defaultBinding(): Binding {
  return { sourceKey: null, peak: 100, floor: 5, decayMs: 400, attackSmooth: 0, decaySmooth: 0.9, chromaSmooth: 0.9, colorSource: 'palette', normMode: 'percentile' };
}

const BINDINGS_STORAGE_KEY = 'lightbox:bindings';

// Loader spreads defaultBinding into each saved entry so any field added in
// later versions (e.g. attackSmooth/decaySmooth split out of an older
// `smooth`) gets a sensible default rather than `undefined` blowing up
// math in the rAF tick.
function loadBindings(): Record<string, Binding> {
  if (typeof window === 'undefined') return {};
  const raw = localStorage.getItem(BINDINGS_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Binding> = {};
    for (const [rid, b] of Object.entries(parsed)) {
      out[rid] = { ...defaultBinding(), ...(b as Partial<Binding>) };
    }
    return out;
  } catch {
    return {};
  }
}

// Energy → chroma-update weight. Raw per-stem energy is typically 0-0.3 even
// on loud sections; multiplying by 5 saturates the weight at ~0.2 raw energy.
// Bigger → chroma responds to quieter sections too; smaller → only the
// loudest moments nudge chroma.
const CHROMA_ENERGY_GATE = 5;

const COLOR_SOURCE_OPTIONS: Array<{ value: ColorSource; label: string }> = [
  { value: 'palette',      label: 'palette · time' },
  { value: 'drums.chroma', label: 'drums · chroma' },
  { value: 'bass.chroma',  label: 'bass · chroma' },
  { value: 'vocals.chroma', label: 'vocals · chroma' },
  { value: 'other.chroma', label: 'other · chroma' },
];

const norm = (s: string) => s.trim().toLowerCase();

export function LightPulseBindings({
  data, firePositionRef, playing, stemEnergyRef, stemEnergyMinMaxRef, stemChromaRef,
}: {
  data: MadmomOnsets | null;
  // Fire-time playhead = master.currentTime − offset_ms/1000. Peak
  // crossings fire when peak <= firePos, matching autopilot's pos_s
  // semantics. Energy/chroma refs from App.tsx are already lookback-
  // delayed by the same offset (ring buffer in App.tsx). One knob
  // (the offset slider) controls every light-event timing.
  firePositionRef: { current: number };
  playing: boolean;
  // Two parallel energy views populated by App.tsx each rAF tick — the
  // binding picks via its `normMode` field which to read.
  stemEnergyRef: { current: Record<Stem, number> };
  stemEnergyMinMaxRef: { current: Record<Stem, number> };
  stemChromaRef: { current: Record<Stem, number> };
}) {
  const [lightsAll, setLightsAll] = useState<LightOption[]>([]);
  const [streamState, setStreamState] = useState<StreamStateResp>({ active: false, channels: [] });
  const [maxSockets, setMaxSockets] = useState(2);
  const [frameHz, setFrameHz] = useState(50);
  const [bindings, setBindings] = useState<Record<string, Binding>>(() => loadBindings());
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // WiZ bulbs choke around 30-50 packets/sec; throttle the rAF dispatch
  // per-bulb so 60Hz tick doesn't translate into 60Hz UDP. Slider in the
  // header lets the user tune it for the specific bulb / network.
  const [wizHz, setWizHz] = useState(25);
  // Tuya bulbs cap themselves through the persistent-connection coalescer
  // (~1 in-flight per device, RTT ≈ 50-150ms), so a higher input rate is
  // wasteful. Default 8 Hz is plenty given the firmware's 800ms internal fade.
  const [tuyaHz, setTuyaHz] = useState(8);
  // (Per-binding normMode lives on each binding now; the earlier parked
  // global mode + localStorage plumbing was removed in favor of per-card
  // selects on energy bindings.)

  // Load once. Combine Hue rest-lights with WiZ devices so both kinds can
  // appear in the same binding dropdown.
  useEffect(() => {
    Promise.all([
      fetch(`${LIGHTBOX_URL}/api/hue-stream/rest-lights`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`hue ${r.status}`)))
        .then(j => (j.lights || []).map((l: any) => ({ rid: l.rid as string, name: l.name as string }))),
      fetch(`${LIGHTBOX_URL}/api/wiz/lights`)
        .then(r => r.ok ? r.json() : { lights: [] })
        .then(j => (j.lights || []).map((l: any) => ({ rid: l.id as string, name: l.name as string })))
        .catch(() => []),
      fetch(`${LIGHTBOX_URL}/api/tuya/lights`)
        .then(r => r.ok ? r.json() : { lights: [] })
        .then(j => (j.lights || []).map((l: any) => ({ rid: l.id as string, name: l.name as string })))
        .catch(() => []),
    ])
      .then(([hue, wiz, tuya]) => setLightsAll([...hue, ...wiz, ...tuya]))
      .catch(e => setLoadErr(String(e)));
    fetch(`${LIGHTBOX_URL}/api/hue-stream/rest-max-sockets`)
      .then(r => r.json()).then(j => { if (typeof j.maxSockets === 'number') setMaxSockets(j.maxSockets); })
      .catch(() => {});
    fetch(`${LIGHTBOX_URL}/api/hue-stream/frame-hz`)
      .then(r => r.json()).then(j => { if (typeof j.hz === 'number') setFrameHz(j.hz); })
      .catch(() => {});
  }, []);

  // Stream state poll — always on, so we can reflect active/inactive in UI.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${LIGHTBOX_URL}/api/hue-stream/state`);
        if (cancelled) return;
        setStreamState(await r.json());
      } catch { /* ignore */ }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Heartbeat the stream watchdog so the server knows this tab is alive.
  // Server tears the stream down if heartbeats stop for ~10s, so closing
  // the tab/page (or losing connectivity) auto-shuts the stream and bulbs
  // come back under REST/palette control. Best-effort sendBeacon on
  // pagehide for instant teardown when possible.
  useEffect(() => {
    const beat = () => {
      fetch(`${LIGHTBOX_URL}/api/hue-stream/heartbeat`, { method: 'POST' }).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 3000);
    const onHide = (e: PageTransitionEvent) => {
      // pagehide also fires when tabbing away (page → bfcache). Only act
      // on REAL teardown — close, navigate, refresh — where persisted is
      // false. Tabbing out leaves the heartbeat-based watchdog (which
      // doesn't fire just from a tab switch since the interval keeps
      // running unless the browser throttles it heavily) as the safety net.
      if (e.persisted) return;
      try {
        navigator.sendBeacon?.(`${LIGHTBOX_URL}/api/hue-stream/stop`, new Blob([''], { type: 'application/json' }));
      } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', onHide);
    return () => { clearInterval(t); window.removeEventListener('pagehide', onHide); };
  }, []);

  // Push server knobs live.
  useEffect(() => {
    fetch(`${LIGHTBOX_URL}/api/hue-stream/rest-max-sockets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxSockets }),
    }).catch(() => {});
  }, [maxSockets]);
  useEffect(() => {
    fetch(`${LIGHTBOX_URL}/api/hue-stream/frame-hz`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hz: frameHz }),
    }).catch(() => {});
  }, [frameHz]);

  // Allowed/visible lights.
  const allowed = useMemo(() => new Set(ALLOWED_LIGHT_NAMES.map(norm)), []);
  const visibleLights = useMemo(
    () => lightsAll.filter(l => allowed.has(norm(l.name))),
    [lightsAll, allowed],
  );
  const ridToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of visibleLights) m.set(l.rid, l.name);
    return m;
  }, [visibleLights]);

  // Light names whose binding is an energy source. Drives Hue entertainment
  // stream lifecycle. WiZ rids are excluded — they're driven over UDP, not
  // through the entertainment config.
  const energyLightNames = useMemo(() => {
    const names: string[] = [];
    for (const rid of Object.keys(bindings)) {
      if (isWizRid(rid) || isTuyaRid(rid)) continue;
      const b = bindings[rid];
      if (!b?.sourceKey) continue;
      const src = SOURCE_BY_KEY.get(b.sourceKey);
      if (src?.kind !== 'energy') continue;
      const name = ridToName.get(rid);
      if (name) names.push(name);
    }
    return names.sort();
  }, [bindings, ridToName]);

  // Stream auto-lifecycle: start/stop/reconfigure so the entertainment
  // config contains exactly the lights that currently have energy bindings.
  // Stop when none, start with appropriate subset when one or more.
  // When the user manually releases the Hue stream (OffsetBar), we set
  // localStorage 'lightbox:hueStreamSuppressed' so the reconcile below
  // doesn't immediately restart it. Clear that suppression as soon as the
  // set of energy-bound lights actually changes — i.e. the user re-binds
  // something and clearly wants lights again. Skip the mount run so a
  // release survives until a real binding change.
  const prevEnergyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const energyKey = energyLightNames.join('|');
    if (prevEnergyKeyRef.current !== null && prevEnergyKeyRef.current !== energyKey) {
      try { localStorage.removeItem('lightbox:hueStreamSuppressed'); } catch {}
    }
    prevEnergyKeyRef.current = energyKey;
  }, [energyLightNames.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastReconcileKey = useRef<string>('');
  useEffect(() => {
    // Respect a manual stream release — don't auto-restart while suppressed.
    try { if (localStorage.getItem('lightbox:hueStreamSuppressed') === '1') return; } catch {}
    const desiredKey = energyLightNames.join('|'); // empty string = "no stream"
    const activeKey = streamState.active
      ? (streamState.channels ?? []).map(c => norm(c.lightName)).sort().join('|')
      : '';
    // Only reconcile when desired ≠ active AND we aren't mid-transition.
    const recKey = `${desiredKey}::${activeKey}`;
    if (lastReconcileKey.current === recKey) return;
    lastReconcileKey.current = recKey;

    // Normalize both sides for comparison (streamState uses raw bridge names
    // which may have trailing whitespace).
    const desiredNorm = energyLightNames.map(norm).sort().join('|');
    const activeNorm = streamState.active
      ? (streamState.channels ?? []).map(c => norm(c.lightName)).filter(n => allowed.has(n)).sort().join('|')
      : '';
    if (desiredNorm === activeNorm) return;

    (async () => {
      // If stream is up but has the wrong subset, stop first.
      if (streamState.active) {
        try { await fetch(`${LIGHTBOX_URL}/api/hue-stream/stop`, { method: 'POST' }); } catch {}
      }
      if (energyLightNames.length === 0) return; // nothing to start
      try {
        await fetch(`${LIGHTBOX_URL}/api/hue-stream/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lightNames: energyLightNames }),
        });
      } catch { /* next poll will retry via effect re-trigger */ }
    })();
    // streamState changes frequently; guard with the key ref above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [energyLightNames.join('|'), streamState.active, streamState.channels?.length]);

  // rid → channelId map from streamState, used when firing /level.
  const ridToChannelId = useMemo(() => {
    const m = new Map<string, number>();
    const byName = new Map<string, number>();
    for (const c of streamState.channels ?? []) byName.set(norm(c.lightName), c.id);
    for (const l of visibleLights) {
      const ch = byName.get(norm(l.name));
      if (ch !== undefined) m.set(l.rid, ch);
    }
    return m;
  }, [streamState.channels, visibleLights]);

  // Pulse-claim (peak bindings only — so the palette animator skips those
  // lights during pulsing). Re-asserted every 10s in case server restarts.
  // WiZ rids excluded: pulse-claim is a Hue/CLIP-v2 concept.
  const peakBoundRids = useMemo(() => {
    return Object.keys(bindings).filter(rid => {
      if (isWizRid(rid) || isTuyaRid(rid)) return false;
      const b = bindings[rid];
      if (!b?.sourceKey) return false;
      return SOURCE_BY_KEY.get(b.sourceKey)?.kind === 'peak';
    });
  }, [bindings]);
  useEffect(() => {
    const post = () => fetch(`${LIGHTBOX_URL}/api/hue-stream/pulse-claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lightIds: peakBoundRids }),
    }).catch(() => {});
    post();
    const t = setInterval(post, 10000);
    return () => clearInterval(t);
  }, [peakBoundRids.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refs for rAF access without re-subscribing.
  const bindingsRef = useRef(bindings);
  const ridToChannelIdRef = useRef(ridToChannelId);
  const wizHzRef = useRef(wizHz);
  const tuyaHzRef = useRef(tuyaHz);
  useEffect(() => { bindingsRef.current = bindings; }, [bindings]);
  useEffect(() => { ridToChannelIdRef.current = ridToChannelId; }, [ridToChannelId]);
  useEffect(() => { wizHzRef.current = wizHz; }, [wizHz]);
  useEffect(() => { tuyaHzRef.current = tuyaHz; }, [tuyaHz]);

  // Persist bindings on every change. Stringify is cheap relative to UI
  // interaction rates (slider drags), no need to debounce.
  useEffect(() => {
    try { localStorage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(bindings)); }
    catch { /* quota / private mode */ }
  }, [bindings]);

  // Chroma → palette-position pusher. ~45Hz — same ballpark as the stream
  // frame rate so color tracks pitch height continuously.
  //
  // The per-binding `chromaSmooth` sets the base EMA α, but the update is
  // ALSO weighted by current stem energy: when the stem is loud, chroma
  // moves toward the raw centroid quickly; when the stem is quiet (tail
  // of a kick, silence between notes), chroma barely drifts. This keeps
  // color from wandering on noise that has no perceptual meaning to the
  // listener. Standard DSP pattern: confidence-weighted EMA.
  const prevChromaBoundRidsRef = useRef<Set<string>>(new Set());
  const chromaSmoothedRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!playing) return;
    // Per-light in-flight tracking. Without this, when lightbox lags even
    // briefly the 45 Hz × N pushes stack up and exhaust Chrome's per-host
    // socket budget — which also starves stem audio downloads → desync.
    const chromaInFlight: Record<string, boolean> = {};
    const t = setInterval(() => {
      const bs = bindingsRef.current;
      const activeChromaRids = new Set<string>();
      for (const rid of Object.keys(bs)) {
        const b = bs[rid];
        if (!b || b.colorSource === 'palette') continue;
        const stem = b.colorSource.split('.')[0] as Stem;
        const rawChroma = stemChromaRef.current[stem] ?? 0.5;
        const rawEnergy = stemEnergyRef.current[stem] ?? 0;
        const alpha = Math.max(0, Math.min(0.99, b.chromaSmooth));
        // Energy weight ∈ [0,1]: how much we trust THIS frame's chroma.
        const w = Math.min(1, rawEnergy * CHROMA_ENERGY_GATE);
        const prev = chromaSmoothedRef.current[rid] ?? rawChroma;
        // Move toward raw at (1-alpha) × w per tick. w=0 ⇒ no update.
        const smoothed = prev + (rawChroma - prev) * (1 - alpha) * w;
        chromaSmoothedRef.current[rid] = smoothed;
        activeChromaRids.add(rid);
        if (chromaInFlight[rid]) continue;
        chromaInFlight[rid] = true;
        fetch(`${LIGHTBOX_URL}/api/hue-stream/palette-position`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lightId: rid, position: smoothed }),
        })
          .catch(() => {})
          .finally(() => { chromaInFlight[rid] = false; });
      }
      // Clear overrides + smoothed state for lights that WERE chroma-bound
      // but aren't now. These are one-shot — no need for per-rid in-flight
      // tracking (at most one fire per rid per binding-change).
      for (const rid of prevChromaBoundRidsRef.current) {
        if (!activeChromaRids.has(rid)) {
          delete chromaSmoothedRef.current[rid];
          fetch(`${LIGHTBOX_URL}/api/hue-stream/palette-position`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lightId: rid, position: null }),
          }).catch(() => {});
        }
      }
      prevChromaBoundRidsRef.current = activeChromaRids;
    }, 22); // ~45Hz
    return () => clearInterval(t);
  }, [playing, stemChromaRef, stemEnergyRef]);

  // Peak cursors. Reset on binding/data change so scrubbing/rebinding
  // doesn't replay past peaks.
  const cursorsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!data) { cursorsRef.current = {}; return; }
    for (const rid of Object.keys(bindings)) {
      const b = bindings[rid];
      const src = b?.sourceKey ? SOURCE_BY_KEY.get(b.sourceKey) : undefined;
      if (!src || src.kind !== 'peak') { cursorsRef.current[rid] = -1; continue; }
      const entry = data[src.path[0]] as { cnn?: number[]; superflux?: number[] } | undefined;
      const peaks = entry?.[src.path[1]] ?? [];
      // Cursor is the count of peaks already past the fire-time playhead.
      // Same scale we'll compare against in the rAF loop below.
      const pos = firePositionRef.current;
      let idx = -1;
      for (let i = 0; i < peaks.length; i++) {
        if (peaks[i] <= pos) idx = i; else break;
      }
      cursorsRef.current[rid] = idx;
    }
  }, [bindings, data, firePositionRef]);

  // Main rAF loop — dispatch by source kind.
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0;
    const lastFireAt: Record<string, number> = {};
    const inFlight: Record<string, boolean> = {};
    const MIN_GAP_MS = 30;
    const energySmoothed: Record<string, number> = {};
    // Per-rid throttles for non-stream brands.
    const lastWizSendAt: Record<string, number> = {};
    const lastTuyaSendAt: Record<string, number> = {};

    // Per-endpoint, per-light in-flight maps. Same reason as the chroma
    // path: rAF-rate POSTs with no backpressure exhaust Chrome's socket
    // budget the moment lightbox is anything slower than instant.
    const levelInFlight: Record<string, boolean> = {};
    const wizInFlight: Record<string, boolean> = {};
    const tuyaInFlight: Record<string, boolean> = {};

    const tick = () => {
      // Peak crossings compare against firePositionRef (offset-shifted).
      // Energy/chroma values from stemEnergyRef/stemChromaRef are also
      // offset-corrected upstream (App.tsx ring-buffer lookback).
      const pos = firePositionRef.current;
      const now = performance.now();
      const bs = bindingsRef.current;
      const chMap = ridToChannelIdRef.current;

      for (const rid of Object.keys(bs)) {
        const b = bs[rid];
        if (!b || !b.sourceKey) continue;
        const src = SOURCE_BY_KEY.get(b.sourceKey);
        if (!src) continue;

        if (src.kind === 'energy') {
          // Energy refs are both in [0,1] (see App.tsx). Binding picks
          // which view via normMode. For combined stems we sum and clamp —
          // keeping it additive matches the "bass+drums" presets that
          // should hit peak when both stems are simultaneously loud.
          const energySrc = b.normMode === 'robust-minmax'
            ? stemEnergyMinMaxRef.current
            : stemEnergyRef.current;
          let raw = 0;
          for (const stem of src.stems) raw += energySrc[stem] ?? 0;
          const rawScaled = Math.max(0, Math.min(1, raw));
          const prev = energySmoothed[rid] ?? rawScaled;
          // Asymmetric EMA: pick alpha based on direction so attack and
          // decay can be tuned independently. Higher alpha = more
          // smoothing (slower change). Standard envelope-follower trick.
          const alpha = rawScaled > prev
            ? Math.max(0, Math.min(0.99, b.attackSmooth))
            : Math.max(0, Math.min(0.99, b.decaySmooth));
          const smoothed = prev * alpha + rawScaled * (1 - alpha);
          energySmoothed[rid] = smoothed;
          const lo = b.floor / 100, hi = b.peak / 100;
          const level = lo + (hi - lo) * smoothed;

          if (isWizRid(rid)) {
            // WiZ has no entertainment stream — push dimming directly via
            // setPilot UDP. No r/g/b means current color stays; only
            // brightness modulates with energy. Floor/peak are interpreted
            // as percent dimming. Clamp to WiZ's 10..100 range.
            // Throttle per-rid: bulb firmware chokes >30-50 Hz.
            const minGapMs = 1000 / Math.max(1, wizHzRef.current);
            if (now - (lastWizSendAt[rid] ?? 0) < minGapMs) continue;
            lastWizSendAt[rid] = now;
            const dimming = Math.max(10, Math.min(100, Math.round(level * 100)));
            if (wizInFlight[rid]) continue;
            wizInFlight[rid] = true;
            fetch(`${LIGHTBOX_URL}/api/wiz/set`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceId: rid, state: true, dimming }),
            })
              .catch(() => {})
              .finally(() => { wizInFlight[rid] = false; });
            continue;
          }

          if (isTuyaRid(rid)) {
            // Tuya: push brightness through setState; the driver coalesces
            // per-device against its persistent connection. Color stays
            // wherever palette/wheel set it. Bulb firmware adds an
            // unavoidable ~800ms fade so the perceived envelope is mushier
            // than Hue/WiZ regardless of client smoothing.
            const minGapMs = 1000 / Math.max(1, tuyaHzRef.current);
            if (now - (lastTuyaSendAt[rid] ?? 0) < minGapMs) continue;
            lastTuyaSendAt[rid] = now;
            const brightness = Math.max(1, Math.min(100, Math.round(level * 100)));
            if (tuyaInFlight[rid]) continue;
            tuyaInFlight[rid] = true;
            fetch(`${LIGHTBOX_URL}/api/tuya/set`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceId: rid, on: true, brightness }),
            })
              .catch(() => {})
              .finally(() => { tuyaInFlight[rid] = false; });
            continue;
          }

          // Hue: push level into the entertainment stream channel.
          const channelId = chMap.get(rid);
          if (channelId === undefined) continue;
          if (levelInFlight[rid]) continue;
          levelInFlight[rid] = true;
          fetch(`${LIGHTBOX_URL}/api/hue-stream/level`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId, level }),
          })
            .catch(() => {})
            .finally(() => { levelInFlight[rid] = false; });
          continue;
        }

        // Peak: WiZ/Tuya peak transport not implemented; skip.
        if (isWizRid(rid) || isTuyaRid(rid)) continue;

        // Peak source — REST path.
        const entry = data[src.path[0]] as { cnn?: number[]; superflux?: number[] } | undefined;
        const peaks = entry?.[src.path[1]] ?? [];
        let cur = cursorsRef.current[rid] ?? -1;
        let fired = false;
        for (let i = cur + 1; i < peaks.length; i++) {
          if (peaks[i] <= pos) { cur = i; fired = true; } else break;
        }
        cursorsRef.current[rid] = cur;
        if (!fired) continue;
        if (now - (lastFireAt[rid] ?? 0) < MIN_GAP_MS) continue;
        lastFireAt[rid] = now;
        if (inFlight[rid]) continue;
        inFlight[rid] = true;
        fetch(`${LIGHTBOX_URL}/api/hue-stream/rest-pulse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lightId: rid, brightness: b.peak, floor: b.floor, decayMs: b.decayMs }),
        })
          .catch(() => {})
          .finally(() => { inFlight[rid] = false; });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, data, firePositionRef, stemEnergyRef, stemEnergyMinMaxRef]);

  const update = (rid: string, patch: Partial<Binding>) => {
    setBindings(prev => ({ ...prev, [rid]: { ...(prev[rid] ?? defaultBinding()), ...patch } }));
  };

  // Force-restart the stream. Also resets the reconciler's internal "last
  // key" so the auto-lifecycle effect picks up the current desired subset
  // on the next run. Useful when the stream gets wedged "starting..." or
  // you just want to force the bridge to reinitialize the entertainment
  // config (rare but does help when Zigbee gets confused).
  const resetStream = async () => {
    try {
      await fetch(`${LIGHTBOX_URL}/api/hue-stream/stop`, { method: 'POST' });
    } catch { /* ignore */ }
    lastReconcileKey.current = ''; // force next reconcile pass
    // Also nudge state so the lifecycle effect re-runs immediately.
    setStreamState({ active: false, channels: [] });
  };
  const bindAllTo = (sourceKey: string) => {
    setBindings(prev => {
      const next = { ...prev };
      for (const l of visibleLights) next[l.rid] = { ...(prev[l.rid] ?? defaultBinding()), sourceKey };
      return next;
    });
  };

  // NOTE: these two useMemos USED to live below the `if (loadErr) return …`
  // early return, which violated rules-of-hooks the first time loadErr
  // flipped from null → string (the hooks count dropped, React tore down).
  // Moved above the early return to keep the call order stable across renders.
  const anyEnergy = energyLightNames.length > 0;
  const anyWizEnergy = useMemo(() => {
    for (const rid of Object.keys(bindings)) {
      if (!isWizRid(rid)) continue;
      const b = bindings[rid];
      if (!b?.sourceKey) continue;
      if (SOURCE_BY_KEY.get(b.sourceKey)?.kind === 'energy') return true;
    }
    return false;
  }, [bindings]);
  const anyTuyaEnergy = useMemo(() => {
    for (const rid of Object.keys(bindings)) {
      if (!isTuyaRid(rid)) continue;
      const b = bindings[rid];
      if (!b?.sourceKey) continue;
      if (SOURCE_BY_KEY.get(b.sourceKey)?.kind === 'energy') return true;
    }
    return false;
  }, [bindings]);

  if (loadErr) {
    return <div className="p-3 text-xs text-red-400 font-mono">lightbox unavailable ({loadErr})</div>;
  }

  return (
    <div className="px-3 py-2 border-t border-zinc-800 bg-zinc-950 overflow-y-auto">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Light pulse bindings</div>
        <span className="text-[10px] text-zinc-600 font-mono">({visibleLights.length} lights)</span>

        <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono"
          title="Node HTTPS agent maxSockets for REST pulses. 1 = strict FIFO; higher = cross-light parallel (per-target order still guaranteed).">
          maxSockets
          <input type="range" min={1} max={8} step={1} value={maxSockets}
            onChange={(e) => setMaxSockets(+e.target.value)} className="w-20" />
          <span className="w-4 text-right">{maxSockets}</span>
        </label>

        {anyEnergy && (
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono"
            title="UDP frame rate for the entertainment stream (only relevant when any energy binding is active).">
            Hz
            <input type="range" min={10} max={60} step={5} value={frameHz}
              onChange={(e) => setFrameHz(+e.target.value)} className="w-20" />
            <span className="w-5 text-right">{frameHz}</span>
          </label>
        )}

        {anyWizEnergy && (
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono"
            title="Max setPilot rate per WiZ bulb. Firmware chokes ~30-50 Hz; if you see stutter or stuck levels, lower this.">
            WiZ Hz
            <input type="range" min={5} max={60} step={1} value={wizHz}
              onChange={(e) => setWizHz(+e.target.value)} className="w-20" />
            <span className="w-5 text-right">{wizHz}</span>
          </label>
        )}

        {anyTuyaEnergy && (
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono"
            title="Max setState rate per Tuya bulb. Driver auto-coalesces against the persistent connection so higher = wasted client traffic; firmware ~800ms fade smears anything fast anyway.">
            Tuya Hz
            <input type="range" min={1} max={20} step={1} value={tuyaHz}
              onChange={(e) => setTuyaHz(+e.target.value)} className="w-20" />
            <span className="w-5 text-right">{tuyaHz}</span>
          </label>
        )}

        <span className="text-[10px] font-mono text-zinc-500" title="Stream is brought up automatically when any light has an energy binding; torn down when none do.">
          stream {anyEnergy
            ? (streamState.active
                ? <span className="text-green-400">on ({streamState.channels?.length ?? 0})</span>
                : <span className="text-amber-400">starting…</span>)
            : <span className="text-zinc-600">off</span>}
        </span>
        {(anyEnergy || streamState.active) && (
          <button
            onClick={resetStream}
            className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white"
            title="Force stop+restart the stream (clears any stuck 'starting…' state, reinitializes the entertainment config on the bridge)"
          >↻ reset</button>
        )}

        <button
          onClick={() => bindAllTo(DEFAULT_SOURCE_KEY)}
          disabled={visibleLights.length === 0}
          className="ml-auto order-last px-2 py-0.5 text-[10px] font-mono rounded bg-indigo-700 hover:bg-indigo-600 disabled:opacity-40"
          title={`Bind every visible light to ${DEFAULT_SOURCE_KEY}`}
        >all → drums_low_strict · sf</button>
      </div>

      {visibleLights.length === 0 ? (
        <div className="text-xs text-zinc-600">Loading lights…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {visibleLights.map((l) => {
            const b = bindings[l.rid] ?? defaultBinding();
            const src = b.sourceKey ? SOURCE_BY_KEY.get(b.sourceKey) : undefined;
            const isEnergy = src?.kind === 'energy';
            // Filter peak dropdown options to sources actually present in
            // this track's madmom data. Preserve the currently-selected key
            // even if missing so bindings never silently disappear.
            const availablePeaks = data
              ? PEAK_SOURCES.filter(s => {
                  const entry = data[s.path[0]] as { cnn?: number[]; superflux?: number[] } | undefined;
                  const arr = entry?.[s.path[1]];
                  return Array.isArray(arr) && arr.length > 0;
                })
              : PEAK_SOURCES;
            const curPeakSel = b.sourceKey && SOURCE_BY_KEY.get(b.sourceKey)?.kind === 'peak'
              ? SOURCE_BY_KEY.get(b.sourceKey) as PeakSourceDef | undefined : undefined;
            const peakOptions = curPeakSel && !availablePeaks.some(s => s.key === curPeakSel.key)
              ? [curPeakSel, ...availablePeaks] : availablePeaks;
            return (
              <div key={l.rid} className="bg-zinc-900 rounded px-2 py-1.5 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xs truncate">{l.name}</span>
                  <select
                    value={b.sourceKey ?? ''}
                    onChange={(e) => update(l.rid, { sourceKey: e.target.value || null })}
                    className="bg-zinc-800 text-[11px] rounded px-1 py-0.5 max-w-[180px]"
                  >
                    <option value="">— off —</option>
                    <optgroup label="peaks (REST)">
                      {peakOptions.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </optgroup>
                    <optgroup label="energy (stream)">
                      {ENERGY_SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </optgroup>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[10px] text-zinc-500">color</span>
                  <select
                    value={b.colorSource}
                    onChange={(e) => update(l.rid, { colorSource: e.target.value as ColorSource })}
                    className="bg-zinc-800 text-[11px] rounded px-1 py-0.5"
                    title="palette · time animates the palette normally. stem · chroma maps that stem's spectral centroid (pitch height, 0-1) to palette position."
                  >
                    {COLOR_SOURCE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                  <span className="w-10 text-right">peak</span>
                  <input type="range" min={1} max={100} value={b.peak}
                    onChange={(e) => update(l.rid, { peak: +e.target.value })}
                    className="flex-1" />
                  <span className="w-8 text-right font-mono">{b.peak}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                  <span className="w-10 text-right">floor</span>
                  <input type="range" min={1} max={100} value={b.floor}
                    onChange={(e) => update(l.rid, { floor: +e.target.value })}
                    className="flex-1" />
                  <span className="w-8 text-right font-mono">{b.floor}</span>
                </div>

                {!isEnergy && (
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span className="w-10 text-right">decay</span>
                    <input type="range" min={50} max={2000} step={10} value={b.decayMs}
                      onChange={(e) => update(l.rid, { decayMs: +e.target.value })}
                      className="flex-1" />
                    <span className="w-12 text-right font-mono">{b.decayMs}ms</span>
                  </div>
                )}
                {isEnergy && (
                  <>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-500"
                      title="How raw stem energy is mapped to [0,1] before floor/peak. percentile = song-CDF rank (auto 50% song-average); robust min-max = (raw − p2)/(p98 − p2) clipped, handles silent stretches by mapping the noise floor to 0.">
                      <span className="w-10 text-right">norm</span>
                      <select
                        value={b.normMode ?? 'percentile'}
                        onChange={(e) => update(l.rid, { normMode: e.target.value as 'percentile' | 'robust-minmax' })}
                        className="flex-1 bg-zinc-800 text-[11px] rounded px-1 py-0.5"
                      >
                        <option value="percentile">percentile</option>
                        <option value="robust-minmax">robust min-max (p2-p98)</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                      <span className="w-10 text-right">attack</span>
                      <input type="range" min={0} max={0.99} step={0.01} value={b.attackSmooth}
                        onChange={(e) => update(l.rid, { attackSmooth: +e.target.value })}
                        className="flex-1"
                        title="Brightness EMA alpha when energy is RISING. 0 = instant attack (snaps to peaks), 0.5 ≈ ~30ms ramp, 0.9 ≈ ~250ms — softens transients." />
                      <span className="w-12 text-right font-mono">{b.attackSmooth.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                      <span className="w-10 text-right">decay</span>
                      <input type="range" min={0} max={0.99} step={0.01} value={b.decaySmooth}
                        onChange={(e) => update(l.rid, { decaySmooth: +e.target.value })}
                        className="flex-1"
                        title="Brightness EMA alpha when energy is FALLING. 0 = snap to floor between hits, 0.9 ≈ 250ms tail, 0.97 ≈ 1s slow fade." />
                      <span className="w-12 text-right font-mono">{b.decaySmooth.toFixed(2)}</span>
                    </div>
                  </>
                )}
                {b.colorSource !== 'palette' && (
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span className="w-10 text-right">col smth</span>
                    <input type="range" min={0} max={0.99} step={0.01} value={b.chromaSmooth}
                      onChange={(e) => update(l.rid, { chromaSmooth: +e.target.value })}
                      className="flex-1"
                      title="Chroma EMA alpha — energy-weighted: during peaks it moves toward raw at (1-α) × w rate (w = clamped stem energy), during silence it holds. 0 = snap on peaks, 0.9 ≈ slower settling, 0.98 ≈ very sticky." />
                    <span className="w-12 text-right font-mono">{b.chromaSmooth.toFixed(2)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
