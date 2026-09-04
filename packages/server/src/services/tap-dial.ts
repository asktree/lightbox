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
import { isHiddenLightName } from '../lib/hidden-lights.js';
import { shiftCurtainsKelvin } from '../routes/ambience.js';

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
  // Fractional remainders so a slow turn still accumulates to whole units.
  const briAccum = new Map<string, number>();

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
      return;
    }
    if (item.type !== 'relative_rotary') return;
    const rot = item.relative_rotary?.rotary_report?.rotation
             ?? item.relative_rotary?.last_event?.rotation;
    const steps = Number(rot?.steps) || 0;
    if (!steps) return;
    const dir = rot.direction === 'clock_wise' ? 1 : -1;
    if (modifierDown) shiftKelvin(-dir * steps * MIRED_PER_STEP);  // cw = cooler
    else shiftBrightness(dir * steps * BRI_PER_STEP);              // cw = brighter
  };

  function targets() {
    return lightManager.getAllLights().filter(
      (l) => l.reachable && l.state.on && !isHiddenLightName(l.name),
    );
  }

  function shiftBrightness(delta: number): void {
    for (const light of targets()) {
      const cur = (light.state.brightness ?? 0) + (briAccum.get(light.id) ?? 0);
      const next = Math.max(1, Math.min(100, cur + delta));
      const v = Math.round(next);
      briAccum.set(light.id, next - v);
      if (v === light.state.brightness) continue;
      lightManager.setLightState(light.id, { brightness: v }, 200).catch(() => {});
    }
  }

  function shiftKelvin(deltaMired: number): void {
    for (const light of targets()) {
      if (light.state.temperature === undefined) continue;   // only pins on the bar
      const m = Math.max(MIRED_COOL, Math.min(MIRED_WARM, 1e6 / light.state.temperature + deltaMired));
      const k = Math.round(1e6 / m);
      if (k === light.state.temperature) continue;
      lightManager.setLightState(light.id, { temperature: k }, 200).catch(() => {});
    }
    void shiftCurtainsKelvin(deltaMired);
  }
}
