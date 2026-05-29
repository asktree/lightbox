// Audio bus — a single in-memory state object holding the latest per-stem
// energy values, plus playback context. Patterns read this; sources write
// to it. There's exactly one source today (MusicboxFollower) but the bus
// is the integration point so adding mic / line-in later doesn't touch
// the patterns.
//
// Values are percentile-mapped to [0,1] on the consuming side
// (musicbox-follower.ts) before being written, so patterns see a uniform
// distribution and don't need to deal with raw RMS scales.

export type Stem = 'drums' | 'bass' | 'vocals' | 'other';
export const STEMS: Stem[] = ['drums', 'bass', 'vocals', 'other'];

export const NUM_BANDS = 12;

export interface AudioBusState {
  // Two normalization views of the per-stem energy.
  //   energy        — empirical-CDF percentile rank against the whole track
  //                   (uniform on [0,1]; treats every "level" equally).
  //   energyMinMax  — robust min-max bounded by p2..p98 of the track's
  //                   distribution (preserves relative loudness: a quiet
  //                   intro really does look quiet).
  // Patterns pick which view to consume via their own param (e.g.
  // megadrome's `normMode`). Same source (musicbox follower / synth)
  // populates both each tick.
  energy: Record<Stem, number>;
  energyMinMax: Record<Stem, number>;
  // 12-band FFT envelope of the equal-weighted stem sum — percentile-mapped
  // per-band against the whole track. Used by megadrome's eq12 mode (true
  // frequency bands, not stems). Same direction-aware smoothing applies.
  bands: number[];
  // Track/playback context for patterns or UI that want to render labels.
  // None of the math depends on these.
  trackId: string | null;
  trackName: string | null;
  position: number; // seconds, interpolated
  playing: boolean;
  // When the last source-update happened (server ms). Patterns can decide
  // to fall back to a default look if this is stale.
  lastUpdate: number;
}

const state: AudioBusState = {
  energy: { drums: 0, bass: 0, vocals: 0, other: 0 },
  energyMinMax: { drums: 0, bass: 0, vocals: 0, other: 0 },
  bands: new Array(NUM_BANDS).fill(0),
  trackId: null,
  trackName: null,
  position: 0,
  playing: false,
  lastUpdate: 0,
};

// Asymmetric smoothing α per direction. attack = applied when the new
// value rises above the previous (snappy=0 → fully responsive); decay =
// applied when it falls (high=0.95 → long tail). Matches the musicbox
// bindings pattern. Uniform across stems for now.
let attackAlpha = 0;
let decayAlpha = 0;
export function getSmoothing() { return { attack: attackAlpha, decay: decayAlpha }; }
export function setSmoothing(a: { attack?: number; decay?: number }) {
  if (typeof a.attack === 'number') attackAlpha = Math.max(0, Math.min(0.99, a.attack));
  if (typeof a.decay === 'number') decayAlpha = Math.max(0, Math.min(0.99, a.decay));
}

export function audioBus(): Readonly<AudioBusState> {
  return state;
}

export function writeEnergy(values: {
  percentile: Record<Stem, number>;
  minMax: Record<Stem, number>;
  bands?: number[]; // optional 12-band percentile values
}) {
  for (const stem of STEMS) {
    {
      const prev = state.energy[stem];
      const next = values.percentile[stem];
      const a = next > prev ? attackAlpha : decayAlpha;
      state.energy[stem] = a > 0 ? prev * a + next * (1 - a) : next;
    }
    {
      const prev = state.energyMinMax[stem];
      const next = values.minMax[stem];
      const a = next > prev ? attackAlpha : decayAlpha;
      state.energyMinMax[stem] = a > 0 ? prev * a + next * (1 - a) : next;
    }
  }
  // Bands — smoothed independently with the same α settings.
  if (values.bands && values.bands.length === NUM_BANDS) {
    for (let b = 0; b < NUM_BANDS; b++) {
      const prev = state.bands[b];
      const next = values.bands[b];
      const a = next > prev ? attackAlpha : decayAlpha;
      state.bands[b] = a > 0 ? prev * a + next * (1 - a) : next;
    }
  }
  state.lastUpdate = Date.now();
}

export function writePlayback(p: { trackId: string | null; trackName?: string | null; position: number; playing: boolean }) {
  state.trackId = p.trackId;
  state.trackName = p.trackName ?? null;
  state.position = p.position;
  state.playing = p.playing;
  state.lastUpdate = Date.now();
}
