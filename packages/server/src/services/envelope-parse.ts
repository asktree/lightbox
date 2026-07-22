// ENV2 binary envelope parsing — extracted verbatim from stem-sync.ts so
// the wire-format contract (shared with musicbox's serializeEnvelope and
// twinklybox's parser) can be unit-tested without importing the Hue
// drivers. Pure: no I/O, no module state.

export const STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
export type Stem = (typeof STEMS)[number];

export interface Envelope {
  trackId: string;
  sr: number;
  numSamples: number;
  stems: Record<Stem, { samples: Float32Array; max: number }>;
  // Chroma proxy from :3002/api/library/:id/chroma — loaded alongside the
  // energy envelope; optional so energy-only drive works if the fetch fails.
  chroma?: Record<Stem, { samples: Float32Array; max: number }>;
}

// ---- ENV2 binary parse (see musicbox envelope.ts serializeEnvelope) ----

export function parseEnvelope(trackId: string, buf: Buffer): Envelope {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'ENV2') {
    throw new Error('bad envelope magic');
  }
  const numStems = buf.readUInt8(4);
  const sr = buf.readUInt16LE(6);
  const numSamples = buf.readUInt32LE(8);
  if (numStems !== STEMS.length) throw new Error(`expected ${STEMS.length} stems, got ${numStems}`);
  const stems = {} as Envelope['stems'];
  let off = 12;
  for (const stem of STEMS) {
    const bytes = numSamples * 4;
    if (off + bytes > buf.length) throw new Error('envelope truncated');
    // Copy out — Buffer's backing ArrayBuffer may be pooled/offset.
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) samples[i] = buf.readFloatLE(off + i * 4);
    let max = 0;
    for (let i = 0; i < numSamples; i++) if (samples[i] > max) max = samples[i];
    stems[stem] = { samples, max };
    off += bytes;
  }
  return { trackId, sr, numSamples, stems };
}
