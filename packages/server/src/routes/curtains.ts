// Curtains: direct control of the igled boxes' native routines (soap,
// twinkle, solid, off) and their parameters. The lightbox client's
// "Curtains" tab talks to this. Soap and twinkle settings persist in the
// ambience state, so the mode toggle (screenbox, tap dial) replays them
// instead of the firmware defaults.
import { Router } from 'express';
import {
  CURTAIN_HOSTS, resolveIp, postRoutine, soapBody, twinkleBody,
  stopTwinklyboxStream, getMutableAmbienceState, saveStateDebounced,
  kelvinToRgbBytes, KELVIN_MIN, KELVIN_MAX,
} from './ambience.js';

// Mirrors PALETTES[] in packages/igled/src/routines.cpp, with the same 16
// stops so the client can draw a true preview. Keep the two in step.
export const SOAP_PALETTE_STOPS: Record<string, string[]> = {
  default: ['#5500AB', '#000000', '#84007C', '#000000', '#E5001B', '#E81700', '#000000', '#000000', '#DD2200', '#000000', '#C2003E', '#8F0071', '#000000', '#5F00A1', '#000000', '#0007F9'],
  ember: ['#E5001B', '#000000', '#8B0000', '#000000', '#DD2200', '#E81700', '#000000', '#000000', '#A00010', '#000000', '#FF1A00', '#000000', '#6A0000', '#C2003E', '#000000', '#E5001B'],
  rose: ['#FF2E7A', '#000000', '#C2003E', '#FF4FA3', '#000000', '#8F0071', '#FF1F8F', '#000000', '#D1006B', '#000000', '#FF69B4', '#B0004F', '#000000', '#FF2E7A', '#000000', '#8F0071'],
  violet: ['#5500AB', '#000000', '#8F0071', '#5F00A1', '#000000', '#2F00D0', '#0007F9', '#000000', '#6A00C8', '#000000', '#84007C', '#3A00B8', '#000000', '#0007F9', '#5500AB', '#000000'],
  midnight: ['#0007F9', '#000000', '#000000', '#0000A0', '#000000', '#000000', '#1030FF', '#000000', '#000000', '#000070', '#000000', '#0007F9', '#000000', '#000000', '#2020C0', '#000000'],
  coal: ['#FF0700', '#000000', '#000000', '#A00400', '#000000', '#000000', '#FF0800', '#000000', '#000000', '#700200', '#000000', '#FF0700', '#000000', '#000000', '#C00500', '#000000'],
  kiln: ['#FF1F00', '#000000', '#000000', '#A01300', '#000000', '#000000', '#FF2000', '#000000', '#000000', '#700E00', '#000000', '#FF1F00', '#000000', '#000000', '#C01700', '#000000'],
  neon: ['#FF00FF', '#000000', '#0040FF', '#000000', '#FF00C8', '#2000FF', '#000000', '#FF00FF', '#000000', '#0060FF', '#000000', '#FF0090', '#000000', '#0040FF', '#FF00FF', '#000000'],
  blood: ['#8B0000', '#000000', '#000000', '#600000', '#000000', '#000000', '#A00000', '#000000', '#000000', '#FF0000', '#000000', '#000000', '#700000', '#000000', '#8B0000', '#000000'],
  candy: ['#FF2E7A', '#0040FF', '#000000', '#FF4FA3', '#2000FF', '#000000', '#FF1F8F', '#0007F9', '#000000', '#FF69B4', '#1030FF', '#000000', '#FF2E7A', '#000000', '#0040FF', '#FF00C8'],
};
export const SOAP_PALETTES = Object.keys(SOAP_PALETTE_STOPS);
const KINDS = ['off', 'solid', 'twinkle', 'soap'] as const;
type Kind = (typeof KINDS)[number];

const clamp = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : undefined;
};

async function readBox(host: string): Promise<{ online: boolean; routine?: unknown }> {
  try {
    const ip = await resolveIp(host);
    const r = await fetch(`http://${ip}/api/routine`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { online: false };
    return { online: true, routine: await r.json() };
  } catch {
    return { online: false };
  }
}

export function createCurtainsRouter(): Router {
  const router = Router();
  const state = getMutableAmbienceState();

  const saved = () => ({
    soap: { speed: state.soapSpeed, smoothness: state.soapSmoothness, palette: state.soapPalette, black: state.soapBlack, bri: state.soapBri },
    twinkle: { kelvin: state.curtainsKelvin, val: state.curtainsVal, periodMs: state.curtainsPeriodMs, cut: state.curtainsCut },
  });

  // Live routine on each box, the palette bank, and the persisted settings.
  router.get('/', async (_req, res) => {
    const boxes: Record<string, { online: boolean; routine?: unknown }> = {};
    await Promise.all(CURTAIN_HOSTS.map(async (h) => { boxes[h] = await readBox(h); }));
    res.json({ hosts: CURTAIN_HOSTS, boxes, palettes: SOAP_PALETTES, paletteStops: SOAP_PALETTE_STOPS, mode: state.mode, ...saved() });
  });

  // Set the routine and/or its parameters. Body: igled's own field names
  // (kind, speed, smoothness, palette, val, periodMs, density, hueJitter,
  // cut, hue, sat, rgb) plus optional `hosts: string[]` to target one box.
  // Without `kind` the boxes keep their current routine and only update
  // the given fields.
  router.post('/routine', async (req, res) => {
    const b = req.body ?? {};
    const hosts: string[] = Array.isArray(b.hosts)
      ? b.hosts.filter((h: unknown) => (CURTAIN_HOSTS as readonly string[]).includes(String(h)))
      : [...CURTAIN_HOSTS];
    if (hosts.length === 0) { res.status(400).json({ error: 'no valid hosts' }); return; }

    const kind: Kind | undefined = KINDS.includes(b.kind) ? b.kind : undefined;
    if (b.kind !== undefined && !kind) { res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` }); return; }

    const out: Record<string, unknown> = {};
    if (kind) out.kind = kind;
    const speed = clamp(b.speed, 0, 255);           if (speed !== undefined) out.speed = speed;
    const smooth = clamp(b.smoothness, 0, 255);     if (smooth !== undefined) out.smoothness = smooth;
    if (typeof b.palette === 'string' && SOAP_PALETTES.includes(b.palette)) out.palette = b.palette;
    const black = clamp(b.black, 0, 240);           if (black !== undefined) out.black = black;
    const bri = clamp(b.bri, 0, 255);               if (bri !== undefined) out.bri = bri;
    const val = clamp(b.val, 0, 255);               if (val !== undefined) out.val = val;
    const period = clamp(b.periodMs, 500, 60000);   if (period !== undefined) out.periodMs = period;
    const density = clamp(b.density, 0, 255);       if (density !== undefined) out.density = density;
    const jitter = clamp(b.hueJitter, 0, 255);      if (jitter !== undefined) out.hueJitter = jitter;
    if (typeof b.cut === 'boolean') out.cut = b.cut;
    const hue = clamp(b.hue, 0, 255);               if (hue !== undefined) out.hue = hue;
    const sat = clamp(b.sat, 0, 255);               if (sat !== undefined) out.sat = sat;
    // Twinkle color as a blackbody kelvin (same path screenbox uses).
    const kelvin = clamp(b.kelvin, KELVIN_MIN, KELVIN_MAX);
    if (kelvin !== undefined) { out.rgb = kelvinToRgbBytes(kelvin); state.curtainsKelvin = kelvin; }
    if (b.rgb && typeof b.rgb === 'object') {
      const r = clamp(b.rgb.r, 0, 255), g = clamp(b.rgb.g, 0, 255), bb = clamp(b.rgb.b, 0, 255);
      if (r !== undefined && g !== undefined && bb !== undefined) out.rgb = { r, g, b: bb };
    }

    // Persist the design so a later mode toggle replays it.
    if (speed !== undefined) state.soapSpeed = speed;
    if (smooth !== undefined) state.soapSmoothness = smooth;
    if (out.palette) state.soapPalette = out.palette as string;
    if (black !== undefined) state.soapBlack = black;
    if (bri !== undefined) state.soapBri = bri;
    if (val !== undefined) state.curtainsVal = val;
    if (period !== undefined) state.curtainsPeriodMs = period;
    if (typeof b.cut === 'boolean') state.curtainsCut = b.cut;
    saveStateDebounced();

    // Switching to a saved routine: send the full saved body, then the
    // overrides from this request on top.
    let body: Record<string, unknown> = out;
    if (kind === 'soap') body = { ...(soapBody() as object), ...out };
    if (kind === 'twinkle') body = { ...(twinkleBody() as object), ...out };

    if (kind) await stopTwinklyboxStream();
    const results = await postRoutine(body, hosts);
    res.json({ sent: body, results, ...saved() });
  });

  return router;
}
