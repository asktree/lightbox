#!/usr/bin/env python3
"""Precompute the dormant-wheel labyrinth for screenbox.

Gray-Scott reaction-diffusion with *anisotropic* diffusion (faster along the
radial direction) so the corridors prefer to run radially. The output is a
signed distance field to the stripe centre-lines, so the firmware can draw
lines of any uniform thickness (and animate that thickness) with one threshold.

Writes src/labyrinth.h:  LAB_DIST[N*N] uint8 = distance (px * 16) to the nearest
stripe centre-line (skeleton). A line of half-width T is `dist <= T`, so
thickness is uniform everywhere and can be animated with one threshold.
  python3 tools/gen_labyrinth.py [--preview out.png]
"""
import argparse
import numpy as np
from scipy import ndimage

N = 208                 # output size; must match 2*WHEEL_R of the board (see --size)
N_SIM = 175             # simulate smaller and upscale -> corridor scale (higher = finer)
F, K = 0.029, 0.057     # feed / kill: "worms" / labyrinth regime
DU, DV = 0.16, 0.08
RADIAL_BIAS = -0.7      # >0: corridors run radially (spokes); <0: tangentially (rings)
STEPS = 6000
SEED = 7
SDF_SCALE = 16          # 1/16 px resolution in the uint8 field

def make_sampler(shape, ux, uy):
    """Bilinear gather of a field at (x+ux, y+uy) for every cell (periodic)."""
    n = shape[0]
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    sx, sy = xx + ux, yy + uy
    x0 = np.floor(sx).astype(int); y0 = np.floor(sy).astype(int)
    fx = (sx - x0).astype(np.float32); fy = (sy - y0).astype(np.float32)
    x0 %= n; y0 %= n; x1 = (x0 + 1) % n; y1 = (y0 + 1) % n
    def sample(a):
        return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x1] * fx * (1 - fy)
                + a[y1, x0] * (1 - fx) * fy + a[y1, x1] * fx * fy)
    return sample

def simulate():
    rng = np.random.default_rng(SEED)
    n = N_SIM
    U = np.ones((n, n), np.float32)
    V = np.zeros((n, n), np.float32)
    for _ in range(60):
        cx, cy = rng.integers(4, n - 4, 2)
        U[cy-3:cy+3, cx-3:cx+3] = 0.5
        V[cy-3:cy+3, cx-3:cx+3] = 0.25
    U += rng.normal(0, 0.02, U.shape).astype(np.float32)
    V += rng.normal(0, 0.02, V.shape).astype(np.float32)

    # radial / tangential unit vectors per cell (about the disc centre)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    dx, dy = xx + 0.5 - n / 2, yy + 0.5 - n / 2
    r = np.maximum(np.hypot(dx, dy), 1.0)
    rx, ry = dx / r, dy / r
    tx, ty = -ry, rx
    s_rp, s_rm = make_sampler(U.shape, rx, ry), make_sampler(U.shape, -rx, -ry)
    s_tp, s_tm = make_sampler(U.shape, tx, ty), make_sampler(U.shape, -tx, -ty)

    def lap(a):
        d_rr = s_rp(a) + s_rm(a) - 2 * a          # second difference along radial
        d_tt = s_tp(a) + s_tm(a) - 2 * a          # ... along tangential
        return 0.5 * ((1 + RADIAL_BIAS) * d_rr + (1 - RADIAL_BIAS) * d_tt)

    for i in range(STEPS):
        uvv = U * V * V
        U += DU * lap(U) - uvv + F * (1 - U)
        V += DV * lap(V) + uvv - (F + K) * V
        np.clip(U, 0, 1, out=U); np.clip(V, 0, 1, out=V)
    return V

def upscale(a, n):
    m = a.shape[0]
    src = (np.arange(n) + 0.5) * m / n - 0.5
    i0 = np.clip(np.floor(src).astype(int), 0, m - 1); i1 = np.clip(i0 + 1, 0, m - 1)
    f = (src - i0)[:, None]
    rows = a[i0] * (1 - f) + a[i1] * f
    f2 = (src - i0)[None, :]
    return rows[:, i0] * (1 - f2) + rows[:, i1] * f2

def main():
    global N, N_SIM
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview')
    ap.add_argument('--size', type=int, default=N, help='field size = 2 * wheel radius')
    ap.add_argument('--out')
    args = ap.parse_args()
    if args.size != N:
        N_SIM = round(N_SIM * args.size / N)      # keep corridor scale relative to the wheel
        N = args.size
    args.out = args.out or f'src/labyrinth_{N}.h'

    V = upscale(simulate(), N)
    yy, xx = np.mgrid[0:N, 0:N]
    disc = (xx + 0.5 - N / 2) ** 2 + (yy + 0.5 - N / 2) ** 2 <= (N / 2) ** 2

    # stripes = upper half of the field -> centre-lines (skeleton) -> distance to them
    mid = np.percentile(V[disc], 50)
    stripe = V >= mid
    try:
        from skimage.morphology import skeletonize
        globals()['skeletonize'] = skeletonize
        skel = skeletonize(stripe)
    except ImportError:
        # fallback: ridge of the inside distance transform (local max along any axis)
        inner = ndimage.distance_transform_edt(stripe)
        skel = np.zeros_like(stripe)
        for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
            a = np.roll(np.roll(inner, dy, 0), dx, 1); b = np.roll(np.roll(inner, -dy, 0), -dx, 1)
            skel |= (inner >= a) & (inner >= b) & stripe & (inner > 0.5)
    dist = ndimage.distance_transform_edt(~skel).astype(np.float32)
    dmax = float(np.percentile(dist[disc], 99.5))   # farthest a pixel is from any centre-line
    q = np.clip(dist * SDF_SCALE + 0.5, 0, 255).astype(np.uint8)
    # the "inverse path": centre-lines of the gaps, kept black when the wheel is awake
    gap_skel = skeletonize(~stripe) if 'skeletonize' in dir() else ndimage.distance_transform_edt(stripe) <= 0
    gap_dist = ndimage.distance_transform_edt(~gap_skel).astype(np.float32)
    qg = np.clip(gap_dist * SDF_SCALE + 0.5, 0, 255).astype(np.uint8)

    with open(args.out, 'w') as f:
        f.write('// Generated by tools/gen_labyrinth.py — distance to labyrinth stripe centre-lines.\n')
        f.write(f'// F={F} K={K} radial_bias={RADIAL_BIAS} steps={STEPS} seed={SEED}\n#pragma once\n#include <stdint.h>\n')
        f.write(f'constexpr int   LAB_N = {N};\n')
        f.write(f'constexpr float LAB_SCALE = {SDF_SCALE}.f;     // field units per px\n')
        f.write(f'constexpr float LAB_DMAX = {dmax:.3f}f;        // px: half-width that closes every gap\n')
        for name, arr in (('LAB_DIST', q), ('LAB_GAPD', qg)):
            f.write(f'static const uint8_t {name}[LAB_N * LAB_N] PROGMEM = {{\n')
            flat = arr.flatten()
            for i in range(0, len(flat), 32):
                f.write('  ' + ','.join(str(int(v)) for v in flat[i:i+32]) + ',\n')
            f.write('};\n')
    print(f'wrote {args.out}: dmax={dmax:.2f}px')

    if args.preview:
        from PIL import Image
        panels = []
        for T in (0.6, 1.6, 99.0):       # line half-widths: dormant, near a light, awake (with inverse path)
            panels.append(((dist <= T) & (gap_dist > 0.5) & disc))
        rgb = np.zeros((N, N * 4, 3), np.uint8)
        rgb[:, :N, :] = (np.clip(1 - dist / dmax, 0, 1)[..., None] * 255).astype(np.uint8)
        for i, m in enumerate(panels):
            rgb[:, N * (i + 1):N * (i + 2), :] = m[..., None] * 255
        Image.fromarray(rgb).resize((N * 4 * 2, N * 2), Image.NEAREST).save(args.preview)
        print('preview', args.preview)

if __name__ == '__main__':
    main()
