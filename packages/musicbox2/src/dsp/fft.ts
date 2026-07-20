// Small radix-2 FFT — same implementation shape as musicbox server's
// envelope.ts. Called 4× per frame on 2048 points; ~µs territory.

export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = angleStep * k;
        const wr = Math.cos(a);
        const wi = Math.sin(a);
        const tr = re[i + k + half] * wr - im[i + k + half] * wi;
        const ti = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}

// A-weighting — perceptual loudness curve, so bass doesn't visually
// dominate on raw physical energy. Ported from musicbox v1.
export function aWeight(freq: number): number {
  if (freq < 1) return 0;
  const f2 = freq * freq;
  const num = 12194 ** 2 * f2 * f2;
  const den =
    (f2 + 20.6 ** 2) *
    Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
    (f2 + 12194 ** 2);
  return den === 0 ? 0 : num / den;
}
