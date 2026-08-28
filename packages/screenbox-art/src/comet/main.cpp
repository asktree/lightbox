// comet: a vertical streak of light floating in a starry sky, spraying
// particles, reflected in dark water below. Monochrome, long-exposure feel.
//
// Sky (stars, halo, streak, spray) is drawn into the frame; the water band is a
// dark ocean covered in blinking horizontal glint strokes (dense/tiny near the
// horizon, sparse/long near the viewer), pooled under the streak.
#include <Arduino.h>
#include <math.h>
#include "canvas.h"
#include "ota.h"

using canvas::frame;
using canvas::W;
using canvas::H;

namespace {

// ---- layout -----------------------------------------------------------------
constexpr int   HORIZON   = (int)(H * 0.70f);         // water starts here (bottom 30%)
constexpr int   WATER_H   = H - HORIZON;
constexpr float LINE_TOP  = H * 0.086f;                // whole streak shifted down (gap to water -33%)
constexpr float LINE_BOT  = H * 0.566f;
constexpr float LINE_LEN  = LINE_BOT - LINE_TOP;
constexpr float CORE_T    = 0.81f;                     // brightest point along the line (0 top .. 1 bottom)
constexpr float HW_MAX    = W * 0.030f;                // glow half-width at the core
constexpr float HALO_R    = W * 0.42f;                 // big soft halo radius
constexpr int   N_STARS   = (W >= 320) ? 1300 : 800;
constexpr int   N_SPRAY   = (W >= 320) ? 700 : 450;
constexpr float WASH_A    = 46.f;                      // light wash rising from the water, grey at the horizon
constexpr float WASH_L    = H * 0.10f;                 // ...and its e-folding height
constexpr int   BIG = (W >= 320) ? 1 : 0;
constexpr float PAN_MAX_X = W * 0.094f, PAN_MAX_Y = H * 0.078f;   // camera pan at the screen edge
constexpr float PAN_UP    = PAN_MAX_Y * 1.3f;          // looking up goes further -- there's something up there
constexpr float CAM_ZOOM  = 1.18f;                     // covers rock + sideways/down pan; a full look-up
                                                       // overshoots the frame, so the top band is cleared

// ---- rng --------------------------------------------------------------------
uint32_t rng = 0xC0FFEE11u;
inline uint32_t xr() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
inline float frand() { return (xr() & 0xFFFFFF) / 16777216.f; }
inline float srand1() { return frand() * 2.f - 1.f; }
inline float gauss() { return (frand() + frand() + frand() - 1.5f) * 1.2f; }   // ~N(0,1)-ish, bounded

// ---- LUTs ------------------------------------------------------------------
uint16_t grayRaw[256];        // grey 0..255 -> raw sprite word (byte order matched at boot)
// RGB565 only has 5 bits of red/blue: a smooth tone ramp through a strongly tinted
// curve steps through visible bands (the "oval" around the halo). The big smooth
// fills (halo, water base, wash) use a 2x2 ordered dither between the two nearest
// representable colours via these four LUT variants, indexed by pixel parity.
uint16_t grayRawD[4][256];
inline uint16_t rawDither(int g, int x, int y) { return grayRawD[((y & 1) << 1) | (x & 1)][g]; }
uint8_t  expLut[257];         // exp(-i/64 * 4) scaled 0..255 for i in 0..256  (x = r^2/R^2)
int8_t   sinLut[256];         // sin(2*pi*i/256) * 127
bool     swapBytes = false;
uint16_t* buf = nullptr;

inline uint16_t rawFromGray(int g) { return grayRaw[g < 0 ? 0 : g > 255 ? 255 : g]; }
#if COMET_RED || COMET_CURVE
uint8_t* toneOf = nullptr;                             // raw 16-bit word -> tone (64 KB, PSRAM)
inline int grayFromRaw(uint16_t r) { return toneOf[r]; }
#else
inline int grayFromRaw(uint16_t r) {
  uint16_t v = swapBytes ? __builtin_bswap16(r) : r;
  return ((v >> 5) & 0x3F) << 2;                       // green channel, 6 -> 8 bits
}
#endif
inline uint16_t* px(int x, int y) { return buf + y * W + x; }
inline void plotMax(int x, int y, int g) {
  if ((unsigned)x >= (unsigned)W || (unsigned)y >= (unsigned)HORIZON) return;
  uint16_t* p = px(x, y);
  if (grayFromRaw(*p) < g) *p = rawFromGray(g);
}
inline void plot(int x, int y, int g) {
  if ((unsigned)x >= (unsigned)W || (unsigned)y >= (unsigned)HORIZON) return;
  *px(x, y) = rawFromGray(g);
}
inline int expAt(float x) {                            // x = (r/R)^2, returns 0..255 * exp(-4x)
  int i = (int)(x * 64.f);
  return i >= 256 ? 0 : expLut[i];
}
inline float sinAt(uint32_t phase) { return sinLut[(phase >> 8) & 0xFF] * (1.f / 127.f); }

// Tone -> plain RGB565 (for setTextColor, which LGFX converts itself).
inline uint16_t toneColor565(int g) { uint16_t v = grayRaw[g < 0 ? 0 : g > 255 ? 255 : g]; return swapBytes ? __builtin_bswap16(v) : v; }
uint32_t labelUntil = 1500;
float panX = 0, panY = 0;                              // current look-pan (logical px)
void buildToneLut();
void buildLuts() {
  for (int i = 0; i <= 256; i++) expLut[i] = (uint8_t)(255.f * expf(-4.f * i / 64.f) + 0.5f);
  for (int i = 0; i < 256; i++) sinLut[i] = (int8_t)(127.f * sinf(i * (2.f * (float)M_PI / 256.f)));
  // Detect the sprite's in-memory byte order: draw pure red, look at the word.
  frame.drawPixel(0, 0, (uint16_t)0xF800);
  uint16_t raw = *(uint16_t*)frame.getBuffer();
  swapBytes = (raw != 0xF800);
  buildToneLut();
}

#if COMET_CURVE
#include "curves.h"                                    // bank from tools/gen_curves.py
int curveIdx = 7;                                      // boot on abyss; a centre tap cycles
#endif
void buildToneLut() {
  for (int g = 0; g < 256; g++) {
    int r = g, gg = g, b = g;
#if COMET_CURVE
    r = CURVES[curveIdx][0][g]; gg = CURVES[curveIdx][1][g]; b = CURVES[curveIdx][2][g];
#elif COMET_RED
    // tone curve: white fades to red, then to black -- green/blue fall off much
    // faster than red, so every dim thing (halo edge, trails, far stars, water) is red
    float t = g / 255.f;
    // the tint channel lingers -- but t^0.6 has infinite slope at 0, which lifted
    // tone 1 to a visible value and drew a hard oval at the halo's cutoff; ease in
    float sl = powf(t, 0.6f) * fminf(1.f, t * 6.f);
    int slow = (int)(255.f * sl + 0.5f);
    float fast = t < 0.7f ? powf(t, 2.2f) : 0.456f + (t - 0.7f) / 0.3f * (1.f - 0.456f);
    int fastI = (int)(255.f * fast + 0.5f);           // the others drop off early
#if COMET_RED == 2
    b = slow; r = gg = fastI;                          // blue variant
#else
    r = slow; gg = b = fastI;                          // red variant
#endif
#else
    if (g > 160) b = g - (g - 160) / 4;                // faint warmth in the brightest tones
#endif
    uint16_t c = ((r & 0xF8) << 8) | ((gg & 0xFC) << 3) | (b >> 3);
    grayRaw[g] = swapBytes ? __builtin_bswap16(c) : c;
    static const int bay[4] = {0, 2, 3, 1};            // 2x2 Bayer order
    for (int k = 0; k < 4; k++) {
      int o5 = bay[k] * 2, o6 = bay[k];                // add 0..6 / 0..3 before truncation
      int rr = min(255, r + o5), g2 = min(255, gg + o6), bb = min(255, b + o5);
      uint16_t cd = ((rr & 0xF8) << 8) | ((g2 & 0xFC) << 3) | (bb >> 3);
      grayRawD[k][g] = swapBytes ? __builtin_bswap16(cd) : cd;
    }
  }
#if COMET_RED || COMET_CURVE
  // exact inverse (raw word -> tone) so read-modify-write paths recover the tone
  // despite the non-linear green channel
  if (!toneOf) toneOf = (uint8_t*)heap_caps_malloc(65536, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!toneOf) toneOf = (uint8_t*)malloc(65536);
  // map every representable word to the nearest tone: fill from the LUTs (plain +
  // dithered), then propagate along the tone ramp for anything unlisted
  memset(toneOf, 0, 65536);
  for (int g = 0; g < 256; g++) { toneOf[grayRaw[g]] = g; for (int k = 0; k < 4; k++) toneOf[grayRawD[k][g]] = g; }
#endif
}

// ---- streak profile ---------------------------------------------------------
float coreX = W * 0.5f, coreXTarget = W * 0.5f;
float breathe = 1.f;

inline float lineY(float t) { return LINE_TOP + t * LINE_LEN; }
// half-width of the glow along the line
inline float halfWidth(float t) {
  float d = (t - CORE_T) / 0.20f;
  float body = expf(-d * d);
  float taper = t > 0.9f ? (1.f - t) * 10.f : 1.f;    // to a point at the bottom
  return (0.35f + HW_MAX * body) * taper * breathe;
}
// peak brightness along the line, 0..1
inline float peak(float t) {
  float d = (t - CORE_T) / 0.26f;
  float body = expf(-d * d);
  float head = t < 0.06f ? t / 0.06f : 1.f;           // fade in at the very top
  // the thin upper part stays bright white, ramping up toward the core; only the
  // lower tail below the core dims off
  float floorB = t < 0.3f ? 0.30f + 0.32f * (t / 0.3f)
              : t < CORE_T ? 0.62f + 0.38f * ((t - 0.3f) / (CORE_T - 0.3f)) : 0.22f;
  return fmaxf(floorB, 0.22f + 0.78f * body) * head;
}

// ---- stars ------------------------------------------------------------------
struct Star { float x, y; uint8_t b, len; uint8_t phase, speed; };
Star stars[N_STARS];

void spawnStar(Star& s, bool anywhere) {
  s.x = frand() * W;
  s.y = frand() * HORIZON;
  if (!anywhere) {                                     // respawn near the core so density stays radial
    float a = frand() * 6.2832f, r = frand() * HORIZON * 0.35f;
    s.x = coreX + cosf(a) * r; s.y = lineY(CORE_T) + sinf(a) * r;
  }
  float d = frand();
  s.b = (uint8_t)(40 + 215 * d * d);
  s.len = (uint8_t)(frand() < 0.55f ? 0 : 1 + (xr() % (2 + BIG)));
  s.phase = xr() & 0xFF;
  s.speed = 1 + (xr() % 4);
}

void drawStars(float dt, uint32_t now) {
  const float cy = lineY(CORE_T);
  for (auto& s : stars) {
    float dx = s.x - coreX, dy = s.y - cy;
    float r2 = dx * dx + dy * dy;
    float inv = 1.f / sqrtf(r2 + 1.f);
    dx *= inv; dy *= inv;
    // long-exposure drift: slow outward motion, faster far from the core
    float drift = (3.f + 25.f * fminf(1.f, r2 / (HALO_R * HALO_R))) * dt * 0.3f;
    s.x += dx * drift; s.y += dy * drift;
    if (s.x < 0 || s.x >= W || s.y < 0 || s.y >= HORIZON) { spawnStar(s, false); continue; }
    float tw = 0.75f + 0.25f * sinAt(((uint32_t)s.phase << 8) + now * s.speed * 16);
    int g = (int)(s.b * tw);
    // density falls off with distance from the core like the photo's radial rain
    if (r2 > HALO_R * HALO_R * 2.5f && (s.phase & 3) == 0) g >>= 1;
    int x0 = (int)s.x, y0 = (int)s.y;
    if (s.len == 0) plotMax(x0, y0, g);
    else {
      float L = s.len * (0.6f + 1.4f * fminf(1.f, r2 / (HALO_R * HALO_R)));
      int x1 = (int)(s.x + dx * L), y1 = (int)(s.y + dy * L);
      int n = max(abs(x1 - x0), abs(y1 - y0));
      if (n == 0) plotMax(x0, y0, g);
      else for (int i = 0; i <= n; i++) plotMax(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, g - (g / 2) * i / n);
    }
  }
}

// ---- halo + streak ------------------------------------------------------------
// The halo is radially symmetric (squashed), so it's baked once at boot into an
// 8-bit image and painted with direct writes right after the clear -- no exp,
// no read-modify-write per pixel. Breathing modulates brightness, not radius.
constexpr int HALO_D = (int)(HALO_R * 1.08f) * 2 + 1;   // a little margin for the breathe
uint8_t* haloImg = nullptr;
void buildHalo() {
  haloImg = (uint8_t*)malloc(HALO_D * HALO_D);
  const float c = HALO_D / 2, invR2 = 1.f / (HALO_R * HALO_R);
  for (int y = 0; y < HALO_D; y++) {
    float dy2 = (y - c) * (y - c) * 0.7f;
    for (int x = 0; x < HALO_D; x++) {
      float dx = x - c;
      int e = expAt((dx * dx + dy2) * invR2);
      haloImg[y * HALO_D + x] = e < 4 ? 0 : (e * 58) >> 8;   // max ~58 at the centre
    }
  }
}
// Base layer: halo + the haze wash above the horizon, composed from their source
// values and written once. (The wash used to read the halo back out of the
// frame through the lossy 6-bit green channel and rewrite it, which dropped the
// tone by up to 3 levels across the whole wash zone -- a straight seam a third
// of the way up the streak.)
uint8_t washCol[W];                                    // horizontal profile of the wash (0..255)
void buildWash() {
  for (int x = 0; x < W; x++) { float dx = (x - coreX) / (W * 0.45f); washCol[x] = (uint8_t)(255.f * (0.65f + 0.35f * expf(-dx * dx))); }
}
void drawBase() {
  const int cy = (int)lineY(CORE_T), cx = (int)coreX, c = HALO_D / 2;
  const int gain = (int)(256 * (0.85f + 0.15f * breathe * breathe));
  const int hy0 = max(0, cy - c), hy1 = min(HORIZON - 1, cy + c);
  const int hx0 = max(0, cx - c), hx1 = min(W - 1, cx + c);
  const int washRows = (int)(WASH_L * 4.f);
  for (int y = 0; y < HORIZON; y++) {
    int wi = HORIZON - 1 - y;                          // rows above the horizon
    int washA = 0;
    if (wi < washRows) { float a = WASH_A * expf(-wi / WASH_L); if (a >= 1.f) washA = (int)(a * 256.f); }
    bool inHalo = y >= hy0 && y <= hy1;
    if (!inHalo && !washA) continue;                   // stays black from the clear
    uint16_t* row = px(0, y);
    const uint8_t* src = inHalo ? haloImg + (y - cy + c) * HALO_D + (hx0 - cx + c) : nullptr;
    for (int x = 0; x < W; x++) {
      int g = 0;
      if (inHalo && x >= hx0 && x <= hx1) g = (src[x - hx0] * gain) >> 8;
      if (washA) g += (washA * washCol[x]) >> 16;
      if (g) row[x] = rawDither(g > 255 ? 255 : g, x, y);
    }
  }
}

void drawStreak() {
  int yTop = (int)LINE_TOP, yBot = (int)LINE_BOT;
  for (int y = yTop; y <= yBot; y++) {
    float t = (y - LINE_TOP) / LINE_LEN;
    float hw = halfWidth(t);
    float pk = peak(t);
    int coreG = (int)(255 * fminf(1.f, pk * 1.15f));
    int cx = (int)(coreX + 0.5f);
    // soft gaussian glow either side, width ~3 * hw
    int reach = (int)(hw * 3.f) + 1;
    float invHw2 = 1.f / (hw * hw);
    for (int dx = -reach; dx <= reach; dx++) {
      int e = expAt(dx * dx * invHw2 * 0.25f);         // exp(-(dx/hw)^2)
      int g = (int)(pk * e * 0.92f);
      if (g > 2) plotMax(cx + dx, y, g);
    }
    plotMax(cx, y, coreG);
    if (hw > 2.f) { plotMax(cx - 1, y, coreG * 9 / 10); plotMax(cx + 1, y, coreG * 9 / 10); }
  }
}

// ---- spray ------------------------------------------------------------------
struct Drop { float x, y, vx, vy, life, maxLife; uint8_t b; };
Drop drops[N_SPRAY];

void spawnDrop(Drop& d) {
  float t = CORE_T + gauss() * 0.16f;
  if (t < 0.05f) t = 0.05f; if (t > 0.98f) t = 0.98f;
  float hw = halfWidth(t);
  d.x = coreX + srand1() * hw * 0.6f;
  d.y = lineY(t);
  float a = frand() * 6.2832f;
  float sp = 6.f + 50.f * frand() * frand() * (1.f + BIG * 0.5f);
  d.vx = cosf(a) * sp * 1.35f;                         // spray a little wider than tall
  d.vy = sinf(a) * sp;
  d.maxLife = 1.2f + 3.f * frand();
  d.life = d.maxLife * frand();                        // stagger on boot
  d.b = (uint8_t)(120 + 135 * frand());
}

constexpr float TRAIL_T = 0.22f;                      // trail spans this many seconds of travel
constexpr float TRAIL_K = 0.14f;                      // trail pixels per px/s of speed
void drawSpray(float dt) {
  for (auto& d : drops) {
    d.life -= dt;
    if (d.life <= 0) { spawnDrop(d); continue; }
    d.x += d.vx * dt; d.y += d.vy * dt;
    d.vx *= (1.f - 0.15f * dt); d.vy *= (1.f - 0.15f * dt);
    float f = d.life / d.maxLife;
    int g = (int)(d.b * (f < 0.7f ? f / 0.7f : 1.f));
    // trail: a short streak back along the velocity, fading toward the tail;
    // length scales with speed so the fast ones near the streak leave the longest
    float sp = sqrtf(d.vx * d.vx + d.vy * d.vy);
    int n = (int)(sp * TRAIL_K);
    if (n > 8) n = 8;
    for (int i = n; i >= 1; i--) {
      float k = (float)i / (n + 1);
      plotMax((int)(d.x - d.vx * k * TRAIL_T), (int)(d.y - d.vy * k * TRAIL_T), (int)(g * (1.f - k) * 0.7f));
    }
    plotMax((int)d.x, (int)d.y, g);
    if (BIG && f > 0.85f) plotMax((int)d.x + 1, (int)d.y, g / 2);
  }
}

// ---- water ------------------------------------------------------------------
#if COMET_DITHER
// 1-bit variant: ordered (Bayer 8x8) threshold over the whole frame.
const uint8_t bayer8[8][8] = {
  { 0, 32,  8, 40,  2, 34, 10, 42}, {48, 16, 56, 24, 50, 18, 58, 26},
  {12, 44,  4, 36, 14, 46,  6, 38}, {60, 28, 52, 20, 62, 30, 54, 22},
  { 3, 35, 11, 43,  1, 33,  9, 41}, {51, 19, 59, 27, 49, 17, 57, 25},
  {15, 47,  7, 39, 13, 45,  5, 37}, {63, 31, 55, 23, 61, 29, 53, 21},
};
// COMET_DITHER=1: 2 levels (black/white). COMET_DITHER=2: 3 levels (black/grey/white),
// dithering only between the two nearest levels, so the pattern amplitude halves.
int ditherLevels = COMET_DITHER >= 2 ? 3 : 2;         // tap the screen to toggle 2 <-> 3
void ditherFrame() {
  const uint16_t white = grayRaw[255], black = grayRaw[0], grey = grayRaw[128];
  const bool three = ditherLevels == 3;
  for (int y = 0; y < H; y++) {
    uint16_t* row = px(0, y);
    const uint8_t* br = bayer8[y & 7];
    for (int x = 0; x < W; x++) {
      int g = grayFromRaw(row[x]);
      int thr = br[x & 7];                             // 0..63
      if (!three)       row[x] = (g >> 2) > thr ? white : black;
      else if (g < 128) row[x] = (g >> 1) > thr ? grey : black;     // 0..127 -> 0..63
      else              row[x] = ((g - 128) >> 1) > thr ? white : grey;
    }
  }
}
#endif

// Haze glow rising from the water: additive gradient over the lowest sky rows,
// a little stronger under the streak's reflection.

// Ocean as a sparkle field, like the photo: a dark surface covered in short
// horizontal glint strokes -- dense and tiny near the horizon, sparser and longer
// near the viewer, concentrated in a column under the streak -- each blinking on
// and off as the swell turns facets in and out of the light.
constexpr int N_GLINT = (W >= 320) ? 5600 : 3200;
struct Glint { float x, t; uint16_t phase; uint8_t speed, b, kind; };   // kind 0 = bright glint, 1 = dim wave stroke
Glint glints[N_GLINT];

void spawnGlint(Glint& g) {
  float u = frand();
  g.t = u * u * 0.98f;                                 // 0 horizon .. 1 bottom, biased to the far water
  g.kind = frand() < 0.3f ? 1 : 0;
  // x: mostly in a column under the streak that widens with nearness, some everywhere
  float colW = W * (0.06f + 0.34f * g.t);
  if (frand() < 0.72f) g.x = coreX + gauss() * colW; else g.x = frand() * W;
  g.phase = xr() & 0xFFFF;
  g.speed = 4 + (xr() % 9);
  g.b = g.kind ? 40 + (xr() % 40) : 150 + (xr() % 106);
}

void drawWater(uint32_t now) {
  // dark base: near-black with faint broad swell bands, plus the streak's glow
  // pooling on the far water just below the horizon
  for (int i = 0; i < WATER_H; i++) {
    float t = (float)i / WATER_H;
    // swell bands in world space: rows map to distance by 1/(t + c), so the bands
    // are crushed together toward the horizon and spread (and sweep faster on
    // screen) as they reach the viewer; amplitude fades out at the far end
    float dist = 1.f / (0.07f + t);                    // ~14 at the horizon .. ~0.93 at the bottom
    float zw = dist * 3.2f;                            // world distance in swell wavelengths
    float swell = sinAt((uint32_t)(zw * 65536.f) - now * 26) * 0.7f + sinAt((uint32_t)(zw * 2.3f * 65536.f) + now * 41) * 0.3f;
    float swellAmp = (3.f + 9.f * t) * fminf(1.f, t * 4.f);
    int base = 14 + (int)(10.f * (1.f - t)) + (int)(swellAmp * swell);
    float pool = 70.f * expf(-t / 0.10f);
    float poolW = W * 0.22f;
    uint16_t* dst = px(0, HORIZON + i);
    for (int x = 0; x < W; x++) {
      float dx = (x - coreX) / poolW;
      int g = base + (int)(pool * expf(-dx * dx));
      dst[x] = rawDither(g > 255 ? 255 : g, x, i);
    }
  }
  // glint strokes
  for (auto& g : glints) {
    // glints don't travel (drifting in t skewed the density over time and opened a
    // gap under the horizon); they blink, and occasionally relocate while dark
    g.x += ((g.phase & 1) ? 0.06f : -0.06f) * g.t;   // gentle sideways wander, no net current
    float s = sinAt(((uint32_t)g.phase << 8) + now * g.speed * 14);
    if (s < 0.15f) {                                     // facet turned away: dark
      if ((xr() & 511) == 0 || g.x < 0 || g.x >= W) spawnGlint(g);
      continue;
    }
    int br = (int)(g.b * (s - 0.15f) / 0.85f);
    if (g.kind == 0 && g.t > 0.5f) br = br * 4 / 5;    // near strokes are broader but a bit softer
    int y = HORIZON + (int)(g.t * WATER_H);
    int len = 1 + (int)(g.t * (g.kind ? 9.f : 5.f) * (W / 240.f));
    int x0 = (int)g.x - len / 2;
    if (y >= H) continue;
    // wave-shaped glints: a little peak with concave flanks (offset ~ 1 - sqrt(|dx|/half)),
    // brightest at the crest. Only the nearer, longer bright ones; the rest stay dashes.
    const bool peaked = false;                           // tried wave-shaped peaks; looked bad
    int h = peaked ? 1 + (int)(g.t * 2.5f) : 0;
    float half = len * 0.5f;
    for (int k = 0; k < len; k++) {
      int x = x0 + k; if ((unsigned)x >= (unsigned)W) continue;
      int yy = y, b = br;
      if (peaked) {
        float f = 1.f - sqrtf(fabsf(k - half + 0.5f) / half);   // 1 at crest .. 0 at the ends
        yy = y - (int)(h * f + 0.5f);
        b = br * (40 + (int)(60 * f)) / 100;
      }
      if (yy < HORIZON || yy >= H) continue;
      uint16_t* row = px(0, yy);
      int cur = grayFromRaw(row[x]);
      int v = g.kind ? cur + b / 2 : max(cur, b);
      row[x] = grayRaw[v > 255 ? 255 : v];
    }
    if (!peaked && g.kind == 0 && g.t > 0.7f && br > 160 && y + 1 < H) {   // nearest bright dashes get 2 px tall
      uint16_t* r2 = px(0, y + 1);
      for (int k = 0; k < len; k++) { int x = x0 + k; if ((unsigned)x < (unsigned)W) { int cur = grayFromRaw(r2[x]); if (cur < br / 2) r2[x] = grayRaw[br / 2]; } }
    }
  }
  // horizon seam
  uint16_t* h = px(0, HORIZON);
  for (int x = 0; x < W; x++) { int g = grayFromRaw(h[x]) + 24; h[x] = grayRaw[g > 255 ? 255 : g]; }
}


uint32_t lastMs = 0, frames = 0, perfMs = 0;

}  // namespace

void setup() {
  Serial.setTxBufferSize(4096);
  Serial.begin(115200);
  delay(100);
  Serial.printf("\n[comet] %dx%d, %d stars, %d drops\n", W, H, N_STARS, N_SPRAY);
  canvas::begin();
  buf = (uint16_t*)frame.getBuffer();
  buildLuts();
  buildHalo();
  buildWash();
  Serial.printf("[comet] sprite byte order %s\n", swapBytes ? "swapped" : "native");
  ota::begin();
  for (auto& s : stars) spawnStar(s, true);
  for (auto& d : drops) spawnDrop(d);
  for (auto& g : glints) spawnGlint(g);
  lastMs = millis();
}

void loop() {
  uint32_t now = millis();
  float dt = (now - lastMs) / 1000.f;
  if (dt < 0.016f) { delay(1); return; }
  if (dt > 0.05f) dt = 0.05f;
  lastMs = now;
  float t = now / 1000.f;

  int tx, ty;
  static bool wasDown = false; static uint32_t downMs = 0; static int downX = 0, downY = 0;
  static int lastX = 0, lastY = 0; static bool dragged = false;
  bool down = canvas::touch(tx, ty);
  if (down && !wasDown) { downMs = now; downX = tx; downY = ty; dragged = false; }
  // touch = look toward the finger: a fixed map from finger position to a small
  // camera pan (edge of screen = max pan), eased in; eases back on release
  float panTX = 0, panTY = 0;
  if (down) {
    lastX = tx; lastY = ty;
    if (abs(tx - downX) > 8 || abs(ty - downY) > 8) dragged = true;
    panTX = -(tx - W * 0.5f) / (W * 0.5f) * PAN_MAX_X;      // scene moves opposite to the look direction
    panTY = -(ty - H * 0.5f) / (H * 0.5f) * (ty < H * 0.5f ? PAN_UP : PAN_MAX_Y);
  }
  float ease = fminf(1.f, (down ? 5.f : 2.5f) * dt);
  panX += (panTX - panX) * ease; panY += (panTY - panY) * ease;
  if (!down && wasDown && !dragged && now - downMs < 400) {
    bool centre = abs(downX - W / 2) < W / 4 && abs(downY - H / 2) < H / 4;
#if COMET_CURVE
    if (centre) {                                                    // a tap near the centre cycles the tone curve
      curveIdx = (curveIdx + 1) % N_CURVES;
      buildToneLut();
      labelUntil = now + 1500;
      Serial.printf("[comet] curve -> %s\n", CURVE_NAMES[curveIdx]);
    }
#endif
#if COMET_DITHER
    if (!centre) { ditherLevels = ditherLevels == 3 ? 2 : 3; Serial.printf("[comet] dither levels -> %d\n", ditherLevels); }
#endif
  }
  wasDown = down;
  coreX += (coreXTarget - coreX) * fminf(1.f, 4.f * dt);
  breathe = 1.f + 0.06f * sinf(t * 1.1f) + 0.03f * sinf(t * 2.7f);

  frame.fillScreen(TFT_BLACK);
  drawBase();                                          // halo + wash: direct writes over black
  drawStars(dt, now);
  drawStreak();
  drawSpray(dt);
  drawWater(now);
#if COMET_DITHER
  ditherFrame();
#endif
  // the note at the very top of the frame, in the band the camera normally crops:
  // only readable when you look all the way up
  {
    float a = (panY / PAN_UP - 0.6f) / 0.4f;
    if (a > 0.02f) {
      if (a > 1) a = 1;
      frame.setFont(&fonts::Font2); frame.setTextDatum(textdatum_t::top_center);
      frame.setTextColor(toneColor565((int)(230 * a)));
      frame.drawString("love, iggy <3", W / 2, 3);
    }
  }
#if COMET_CURVE
  {  // palette name: shown for 1.5 s after a switch (and at boot), then fades over 0.5 s.
     // Camera zoom crops ~8% off every edge, so it sits well inside.
    float a = now < labelUntil ? 1.f : 1.f - (now - labelUntil) / 500.f;
    if (a > 0.02f) {
      frame.setFont(&fonts::Font0); frame.setTextDatum(textdatum_t::bottom_left);
      frame.setTextColor(toneColor565((int)(230 * a)));   // the palette's own colour at 90% tone
      frame.drawString(CURVE_NAMES[curveIdx], W / 10, H - H / 10);
    }
  }
#endif
  if (!ota::online()) plot(W - 2, 1, 90);
  // boat POV: slow roll + heave/pitch from a couple of incommensurate swells
  float roll  = 2.2f * sinf(t * 0.61f) + 0.9f * sinf(t * 1.37f + 1.f);
  float heave = 5.0f * sinf(t * 0.47f + 2.f) + 2.0f * sinf(t * 1.13f);
  float sway  = 2.5f * sinf(t * 0.53f + 4.f);
  float lookRoll = -panX / PAN_MAX_X * 1.2f;               // a touch of lean into the turn
  canvas::presentCamera(roll + lookRoll, sway + panX, heave + panY, CAM_ZOOM);

  frames++;
  if (now - perfMs > 5000) {
    Serial.printf("[comet] %.1f fps, heap=%u\n", frames * 1000.f / (now - perfMs), ESP.getFreeHeap());
    frames = 0; perfMs = now;
  }
}
