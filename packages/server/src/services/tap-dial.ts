// Hue Tap Dial -> stack control.
//   bare rotation                 = brightness for the lights that are on
//   rotation while button 1 held  = kelvin: shift each CT-mode light (and
//                                   the curtains twinkle) along the locus,
//                                   and pause any palette that drives them
//   rotation while button 2 held  = the blind: the chord cancels any
//                                   movement, then the dial sets the openness
//   button 2 tapped alone         = the blind: go to the far end, then
//                                   pause / reverse on each tap (shade-tap.ts)
//   buttons 3-4                   = untouched; the bridge keeps their
//                                   app-assigned behavior (button 2 also
//                                   still fires its Hue app action, if any)
// Events arrive on the Hue EventStream the driver already holds open.
// Clockwise raises the value in all modes (brighter / cooler / more open).
import type { LightManager } from '../lib/light-manager.js';
import type { HueDriver } from '../drivers/hue.js';
import type { PaletteAnimator } from '../lib/palette-animator.js';
import { fetchShadeState, sendShade, shadeStatus } from './shade.js';
import { ShadeTap } from './shade-tap.js';
import { RotaryReports, type RotarySource } from './rotary-reports.js';

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
const SHADE_PER_STEP = 0.35;  // percent open
// A board state older than this does not tell if the blind moves now.
const SHADE_STATE_FRESH_MS = 2000;
// While a blind movement runs, read the board state this often.
const SHADE_POLL_MS = 1000;
const SHADE_POLL_FOR_MS = 30_000;
// A tap waits at most this long for a fresh board state.
const SHADE_TAP_WAIT_MS = 500;
// The board needs about this long to send a command to the blind and to
// show it in its state.
const SHADE_CMD_SETTLE_MS = 1500;
// While the dial turns, read its resource from the bridge in a fast loop
// (rotary-reports.ts tells why). One read takes about 15 ms.
const ROTARY_READ_GAP_MS = 50;       // pause between two reads
const ROTARY_READ_FOR_MS = 1500;     // read this long after the last report
const ROTARY_READ_TIMEOUT_MS = 300;
// A held button 1 or 2 usually comes before a turn. Read while it is held,
// but not longer than this.
const ROTARY_READ_HOLD_MS = 8000;

// For the log: the time from the bridge's own stamp on an event to its
// arrival here. It includes the clock difference between the bridge and
// this machine, so read it as a trend, not as an exact number.
function bridgeLag(updated: unknown): string {
  const t = typeof updated === 'string' ? Date.parse(updated) : NaN;
  return Number.isNaN(t) ? '' : ` lag=${Date.now() - t}ms`;
}

export function startTapDial(lightManager: LightManager, paletteAnimator: PaletteAnimator): void {
  const hue = lightManager.getDriverByBrand<HueDriver>('hue');
  if (!hue) return;

  let modifierButtonId: string | null = null;
  let modifierDown = false;
  let shadeButtonId: string | null = null;
  let shadeDown = false;
  // Blind target for the current button-2 hold. null = the dial has not
  // turned yet in this hold.
  let shadeTarget: number | null = null;
  // Direction of the last dial step in this hold: 1 open, -1 close, 0 none.
  let shadeDialDir = 0;
  // The dial turned in this hold, so the release is not a tap.
  let shadeRotated = false;
  // The state read that starts at each button-2 press.
  let shadeFetch: Promise<unknown> = Promise.resolve();
  const shadeTap = new ShadeTap();
  const rotaryReports = new RotaryReports();
  let rotaryReadUntil = 0;
  let rotaryHoldUntil = 0;
  let rotaryReading = false;
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
      if (b?.metadata?.control_id === 1) modifierButtonId ??= b.id;
      if (b?.metadata?.control_id === 2) shadeButtonId ??= b.id;
    }
    console.log(modifierButtonId
      ? `tap-dial: kelvin modifier = button 1 (${modifierButtonId.slice(0, 8)}…)`
      : 'tap-dial: no button 1 on the bridge — kelvin chord disabled');
    console.log(shadeButtonId
      ? `tap-dial: blind modifier = button 2 (${shadeButtonId.slice(0, 8)}…)`
      : 'tap-dial: no button 2 on the bridge — blind chord disabled');
  });
  // Learn the last report of the dial, so the first read in a turn can act.
  void readRotary();

  hue.onRemoteEvent = (item) => {
    if (item.type === 'button') {
      const ev = item.button?.button_report?.event ?? item.button?.last_event;
      if (shadeButtonId && item.id === shadeButtonId) {
        if (ev === 'initial_press') {
          shadeDown = true;
          shadeTarget = null;
          shadeDialDir = 0;
          shadeRotated = false;
          // Get a fresh position now, so the first dial tick (or the tap)
          // starts from it.
          shadeFetch = fetchShadeState().catch(() => {});
          readRotaryWhileHeld();
        } else if (ev === 'short_release' || ev === 'long_release') {
          shadeDown = false;
          // A short press with no dial turn is a tap.
          if (ev === 'short_release' && !shadeRotated) void tapShade();
        }
        console.log(`tap-dial: button2 ${ev} (blind ${shadeDown ? 'DOWN' : 'up'})${bridgeLag(item.button?.button_report?.updated)}`);
        return;
      }
      if (item.id !== modifierButtonId) return;      // buttons 3-4 pass through
      if (ev === 'initial_press') { modifierDown = true; readRotaryWhileHeld(); }
      else if (ev === 'short_release' || ev === 'long_release') modifierDown = false;
      console.log(`tap-dial: button1 ${ev} (modifier ${modifierDown ? 'DOWN' : 'up'})`);
      return;
    }
    if (item.type === 'relative_rotary') onRotary(item, 'stream');
  };

  function onRotary(item: any, via: RotarySource): void {
    const report = item.relative_rotary?.rotary_report;
    const rot = report?.rotation ?? item.relative_rotary?.last_event?.rotation;
    const steps = Number(rot?.steps) || 0;
    if (!steps) return;
    const verdict = rotaryReports.accept(String(item.id), report?.updated, via, Date.now());
    if (!verdict.act) {
      // The stream gave a report that a read had before. The log shows how
      // much time the read saved.
      if (verdict.why === 'duplicate' && via === 'stream' && verdict.firstVia === 'read') {
        console.log(`tap-dial: rotary on the stream ${verdict.afterMs}ms after the read`);
      }
      return;
    }
    const dir = rot.direction === 'clock_wise' ? 1 : -1;
    console.log(`tap-dial: rotary ${dir > 0 ? '+' : '-'}${steps} -> ${shadeDown ? 'blind' : modifierDown ? 'kelvin' : 'brightness'}${bridgeLag(report?.updated)}${rot.duration !== undefined ? ` batch=${rot.duration}ms` : ''} via=${via}${verdict.firstOfTurn ? ' first' : ''}`);
    // The bridge delivers rotary ticks in clumps. Replaying each tick as its
    // own command made a spin land as separate ramps ("two bursts") plus a
    // backlog. Accumulate the deltas and send one command per flush window:
    // the first tick flushes at once, the rest fold into the next flush.
    if (shadeDown) shadeRotated = true;
    if (shadeDown) pendShade += dir * steps * SHADE_PER_STEP;      // cw = more open
    else if (modifierDown) pendMired += -dir * steps * MIRED_PER_STEP;  // cw = cooler
    else pendBri += dir * steps * BRI_PER_STEP;                    // cw = brighter
    scheduleFlush();
    rotaryReadUntil = Date.now() + ROTARY_READ_FOR_MS;
    startRotaryReads();
  }

  async function readRotary(): Promise<void> {
    const items = await hue!.getClipFast('relative_rotary', ROTARY_READ_TIMEOUT_MS);
    for (const item of items ?? []) onRotary(item, 'read');
  }

  function readRotaryWhileHeld(): void {
    rotaryHoldUntil = Date.now() + ROTARY_READ_HOLD_MS;
    startRotaryReads();
  }

  function startRotaryReads(): void {
    if (rotaryReading) return;
    rotaryReading = true;
    void (async () => {
      try {
        for (;;) {
          const now = Date.now();
          const held = (modifierDown || shadeDown) && now < rotaryHoldUntil;
          if (now >= rotaryReadUntil && !held) break;
          await readRotary();
          await new Promise((r) => setTimeout(r, ROTARY_READ_GAP_MS));
        }
      } finally {
        rotaryReading = false;
      }
    })();
  }

  let pendBri = 0;
  let pendMired = 0;
  let pendShade = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  const FLUSH_MS = 140;

  function scheduleFlush(): void {
    if (flushTimer) return;          // a window is open; deltas keep folding in
    flush();                         // leading edge: act on the first tick now
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (pendBri !== 0 || pendMired !== 0 || pendShade !== 0) scheduleFlush();
    }, FLUSH_MS);
  }

  function flush(): void {
    if (pendBri !== 0) { shiftBrightness(pendBri); pendBri = 0; }
    if (pendMired !== 0) { shiftKelvin(pendMired); pendMired = 0; }
    if (pendShade !== 0) { shiftShade(pendShade); pendShade = 0; }
  }

  // The last position that the board gave, or null.
  function shadeOpen(): number | null {
    const open = shadeStatus().state?.open;
    return typeof open === 'number' && open >= 0 ? open : null;
  }

  // Keep the board state fresh while the blind moves, so the next tap or
  // dial step knows where the blind is and if it still moves.
  let shadePollUntil = 0;
  let shadePollTimer: NodeJS.Timeout | null = null;
  function pollShade(): void {
    shadePollUntil = Date.now() + SHADE_POLL_FOR_MS;
    if (shadePollTimer) return;
    shadePollTimer = setInterval(() => {
      if (Date.now() > shadePollUntil) {
        clearInterval(shadePollTimer!);
        shadePollTimer = null;
        return;
      }
      fetchShadeState().catch(() => {});
    }, SHADE_POLL_MS);
  }

  // Button 2 tapped alone. The rules are in shade-tap.ts. Wait a short time
  // for the state read from the press, because the first tap after a pause
  // picks its direction from the position.
  async function tapShade(): Promise<void> {
    await Promise.race([shadeFetch, new Promise((r) => setTimeout(r, SHADE_TAP_WAIT_MS))]);
    const st = shadeStatus();
    const now = Date.now();
    // The board's "moving" flag counts only if the state is fresh and was
    // read after the board had time to start our last command.
    const boardKnows = st.state !== null && st.stateAgeMs !== null
      && st.stateAgeMs < SHADE_STATE_FRESH_MS
      && now - st.stateAgeMs > shadeCmdAt + SHADE_CMD_SETTLE_MS;
    shadeTap.setTravelMs(st.state?.travelMs);
    const action = shadeTap.tap(now, shadeOpen(), boardKnows ? st.state!.moving : null, boardKnows ? st.state!.dir : null);
    console.log(`tap-dial: button2 tap -> blind ${action.kind === 'go' ? `go ${action.open}` : 'stop'}`);
    commandShade(action);
  }

  let shadeCmdAt = 0;   // time of our last command to the blind
  function commandShade(cmd: Parameters<typeof sendShade>[0]): void {
    shadeCmdAt = Date.now();
    sendShade(cmd);
    pollShade();
  }

  // The first tick of a hold starts from the blind's last known position.
  // So does the first tick after the dial changes direction: the new target
  // counts from where the blind is now, not from the old target. A go-to
  // command replaces any movement in progress, so the chord also cancels it.
  // If the position is not known, stop the blind and wait for a position.
  function shiftShade(delta: number): void {
    const dir = delta > 0 ? 1 : -1;
    const open = shadeOpen();
    if (shadeTarget === null || dir !== shadeDialDir) {
      if (open !== null) shadeTarget = open;
      else if (shadeTarget === null) {
        sendShade({ kind: 'stop' });
        return;
      }
    }
    shadeDialDir = dir;
    const prev = Math.round(shadeTarget);
    shadeTarget = Math.max(0, Math.min(100, shadeTarget + delta));
    const v = Math.round(shadeTarget);
    if (v === prev) return;
    commandShade({ kind: 'go', open: v });
    shadeTap.noteMove(Date.now(), open, v);
  }

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
      lightManager.setLightState(light.id, { brightness: v }, 150).catch(() => {});
    }
  }

  function shiftKelvin(deltaMired: number): void {
    const lights = targets();
    // A kelvin turn means white light. Stop the palette first, so that its
    // next tick does not paint a color over the new kelvin.
    void paletteAnimator.pauseRoomsWithLights(lights.map((l) => l.id)).then((rooms) => {
      if (rooms.length) console.log(`tap-dial: kelvin paused the palette in ${rooms.join(', ')}`);
    });
    for (const light of lights) {
      const e = sessionFor(light.id);
      const curMired = e.mired
        ?? (light.state.temperature !== undefined ? 1e6 / light.state.temperature : 1e6 / 2700);
      const m = Math.max(MIRED_COOL, Math.min(MIRED_WARM, curMired + deltaMired));
      const prevK = Math.round(1e6 / curMired);
      e.mired = m;
      e.at = Date.now();
      const k = Math.round(1e6 / m);
      if (k === prevK) continue;
      lightManager.setLightState(light.id, { temperature: k }, 150).catch(() => {});
    }
  }
}
