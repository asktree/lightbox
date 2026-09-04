// Hue Tap Dial -> stack control.
//   bare rotation                 = brightness for the lights that are on
//   rotation while button 1 held  = kelvin: shift each CT-mode light (and
//                                   the curtains twinkle) along the locus
//   buttons 2-4                   = untouched; the bridge keeps their
//                                   app-assigned behavior
// Events arrive on the Hue EventStream the driver already holds open.
// Clockwise raises the value in both modes (brighter / cooler).
import type { LightManager } from '../lib/light-manager.js';
import type { HueDriver } from '../drivers/hue.js';

// The dial lives in the bedroom — it controls only the two bedroom strips.
const TARGET_IDS = ['hue:3', 'hue:4'];   // spaceship floor, cockpit

const KELVIN_MIN = 1000;
const KELVIN_MAX = 6500;
const MIRED_WARM = 1e6 / KELVIN_MIN;
const MIRED_COOL = 1e6 / KELVIN_MAX;
// Gains per rotary step. The dial reports a batch of steps a few times per
// second while it turns.
const BRI_PER_STEP = 0.35;    // percent
const MIRED_PER_STEP = 2.0;   // full kelvin range in roughly 1.5 turns

export function startTapDial(lightManager: LightManager): void {
  const hue = lightManager.getDriverByBrand<HueDriver>('hue');
  if (!hue) return;

  let modifierButtonId: string | null = null;
  let modifierDown = false;
  // During a rotation burst, compound on OUR last-sent targets, not on the
  // light's reported state — echoes lag behind (transition ramps + event
  // latency) and reading them back mid-turn rubber-bands the value.
  const session = new Map<string, { bri?: number; mired?: number; at: number }>();
  const SESSION_TTL_MS = 1500;
  function sessionFor(id: string) {
    const e = session.get(id);
    if (e && Date.now() - e.at < SESSION_TTL_MS) return e;
    const fresh = { at: Date.now() };
    session.set(id, fresh);
    return fresh as { bri?: number; mired?: number; at: number };
  }

  void hue.getClipResource('button').then((buttons) => {
    for (const b of buttons) {
      if (b?.metadata?.control_id === 1) { modifierButtonId = b.id; break; }
    }
    console.log(modifierButtonId
      ? `tap-dial: kelvin modifier = button 1 (${modifierButtonId.slice(0, 8)}…)`
      : 'tap-dial: no button 1 on the bridge — kelvin chord disabled');
  });

  hue.onRemoteEvent = (item) => {
    if (item.type === 'button') {
      if (item.id !== modifierButtonId) return;      // buttons 2-4 pass through
      const ev = item.button?.button_report?.event ?? item.button?.last_event;
      if (ev === 'initial_press') modifierDown = true;
      else if (ev === 'short_release' || ev === 'long_release') modifierDown = false;
      console.log(`tap-dial: button1 ${ev} (modifier ${modifierDown ? 'DOWN' : 'up'})`);
      return;
    }
    if (item.type !== 'relative_rotary') return;
    const rot = item.relative_rotary?.rotary_report?.rotation
             ?? item.relative_rotary?.last_event?.rotation;
    const steps = Number(rot?.steps) || 0;
    if (!steps) return;
    const dir = rot.direction === 'clock_wise' ? 1 : -1;
    console.log(`tap-dial: rotary ${dir > 0 ? '+' : '-'}${steps} -> ${modifierDown ? 'kelvin' : 'brightness'}`);
    if (modifierDown) shiftKelvin(-dir * steps * MIRED_PER_STEP);  // cw = cooler
    else shiftBrightness(dir * steps * BRI_PER_STEP);              // cw = brighter
  };

  function targets() {
    return TARGET_IDS
      .map((id) => lightManager.getLight(id))
      .filter((l): l is NonNullable<typeof l> => !!l && l.reachable && l.state.on);
  }

  function shiftBrightness(delta: number): void {
    for (const light of targets()) {
      const e = sessionFor(light.id);
      const cur = e.bri ?? light.state.brightness ?? 50;
      const next = Math.max(1, Math.min(100, cur + delta));
      const prev = Math.round(cur);
      e.bri = next;
      e.at = Date.now();
      const v = Math.round(next);
      if (v === prev && e.bri !== undefined) continue;
      lightManager.setLightState(light.id, { brightness: v }, 200).catch(() => {});
    }
  }

  function shiftKelvin(deltaMired: number): void {
    for (const light of targets()) {
      const e = sessionFor(light.id);
      const curMired = e.mired
        ?? (light.state.temperature !== undefined ? 1e6 / light.state.temperature : 1e6 / 2700);
      const m = Math.max(MIRED_COOL, Math.min(MIRED_WARM, curMired + deltaMired));
      const prevK = Math.round(1e6 / curMired);
      e.mired = m;
      e.at = Date.now();
      const k = Math.round(1e6 / m);
      if (k === prevK) continue;
      lightManager.setLightState(light.id, { temperature: k }, 200).catch(() => {});
    }
  }
}
