// fish3d: option-3 variant of fish — free 3-D boids held near a spherical
// shell by a spring, instead of fish constrained to the sphere's surface.
// The school bulges, thins and dives through the shell on its own; the
// curl-noise current, Perlin-hue trails, hollow squares and touch predator
// carry over from src/fish.
#include <Arduino.h>
#include <math.h>
#include "canvas.h"
#include "ota.h"
#include "sliders.h"

using canvas::frame;
using canvas::W;
using canvas::H;

namespace {

// ---- tunables ---------------------------------------------------------------
constexpr int   N          = (W >= 320) ? 700 : 490;   // fish count
constexpr float R          = fminf(W, H) * 0.28f;     // shell radius on screen, px
constexpr float CX         = W * 0.5f, CY = H * 0.5f;
constexpr float PERSP      = 0.22f;                    // 0 = orthographic
constexpr int   SQ_MIN     = 3;                        // hollow square, back
constexpr int   SQ_MAX     = (W >= 320) ? 6 : 5;       // ...front
constexpr float CRUISE     = 0.9f;                     // units/s (shell radius = 1)
constexpr float SPEED_MIN  = 0.15f, SPEED_MAX = 3.8f;
constexpr float TURN       = 3.0f;                     // how fast velocity chases desired
// steering weights (all feed the "desired direction" that is normalised to cruise speed)
float W_FLOW     = 0.5f;                     // tangential current (kept weak: it never points inward)
constexpr float W_ALIGN    = 0.9f;                     // match cell velocity
float W_COHESE   = 1.0f;                     // toward cell centroid (3-D)
float W_SEP      = 8.0f;                     // away from close neighbours
constexpr float SEP_D      = 0.09f;                    // separation distance, shell units (~2.5 fish widths)
constexpr float W_JITTER   = 0.4f;
float W_GLOBAL   = 1.2f;
float zoom       = 1.0f;                     // pull toward the sphere centre
// shell attractor (applied as a real acceleration, not part of the normalised steering)
// No shell spring: cohesion + separation shape the school on their own. The only
// confinement is a soft wall at R_MAX so the flock can't wander off-screen.
constexpr float R_MAX      = 1.25f;
constexpr float BAND_SPLIT = 0.6f;                     // flock cells split inner core / outer
// predator (finger)
constexpr float FEAR_D     = 0.55f;                    // 3-D distance from the touch point
constexpr float FEAR_K     = 6.0f;
constexpr int   CELL_CAP   = 10;                       // fish tracked per cell for separation
constexpr int   TRAIL      = 6;                        // history samples per fish
constexpr int   TRAIL_EVERY= 2;                        // frames between samples
constexpr float NOISE_SCALE= 2.2f;
constexpr int   LAT = 12, LON = 24, BANDS = 2;         // flock cells: angular grid x radial band (core/outer)

struct V3 { float x, y, z; };
inline V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 operator*(V3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline float len(V3 a) { return sqrtf(dot(a, a)); }
inline V3 norm(V3 a) { float l = len(a); return l > 1e-6f ? a * (1.f / l) : V3{0, 0, 1}; }
inline V3 tangent(V3 v, V3 n) { return v - n * dot(v, n); }   // strip the component along unit n

struct Fish {
  V3    p;        // free position (shell radius = 1)
  V3    v;        // free velocity
  float panic;    // 0..1, decays
  float hue;      // 0 blue .. 1 orange, from the perlin field (trail colour)
  V3    hist[TRAIL];   // previous positions, newest first
};
Fish fish[N];

struct Cell { V3 sumV, sumP; int n; int16_t idx[CELL_CAP]; V3 flow; bool flowDone; };
Cell cells[LAT * LON * BANDS];

uint32_t rng = 0x9E3779B9u;
inline uint32_t xr() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
inline float frand() { return (xr() & 0xFFFFFF) / 16777216.f; }          // [0,1)
inline float srand1() { return frand() * 2.f - 1.f; }                     // [-1,1)

// Cell from a unit direction plus which side of the shell the fish is on.
inline int cellOf(V3 dir, float r) {
  int la = (int)((dir.z * 0.5f + 0.5f) * LAT); if (la >= LAT) la = LAT - 1;
  int lo = (int)((atan2f(dir.y, dir.x) + (float)M_PI) * (LON / (2.f * (float)M_PI))); if (lo >= LON) lo = LON - 1;
  int band = r < BAND_SPLIT ? 0 : 1;
  return (band * LAT + la) * LON + lo;
}

V3 randomOnSphere() {
  for (;;) {
    V3 p{srand1(), srand1(), srand1()};
    float l = len(p);
    if (l > 0.05f && l < 1.f) return p * (1.f / l);
  }
}

// 3-D value noise (smooth lattice hash) and a curl-style flow derived from it.
inline uint32_t hash3(int x, int y, int z) {
  uint32_t h = (uint32_t)x * 374761393u + (uint32_t)y * 668265263u + (uint32_t)z * 2147483647u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}
inline float lat(int x, int y, int z) { return (hash3(x, y, z) & 0xFFFF) / 65535.f; }
inline float smooth(float t) { return t * t * (3.f - 2.f * t); }
float noise3(float x, float y, float z) {
  int xi = (int)floorf(x), yi = (int)floorf(y), zi = (int)floorf(z);
  float fx = smooth(x - xi), fy = smooth(y - yi), fz = smooth(z - zi);
  float c00 = lat(xi, yi, zi)     + (lat(xi + 1, yi, zi)     - lat(xi, yi, zi))     * fx;
  float c10 = lat(xi, yi + 1, zi) + (lat(xi + 1, yi + 1, zi) - lat(xi, yi + 1, zi)) * fx;
  float c01 = lat(xi, yi, zi + 1)     + (lat(xi + 1, yi, zi + 1)     - lat(xi, yi, zi + 1))     * fx;
  float c11 = lat(xi, yi + 1, zi + 1) + (lat(xi + 1, yi + 1, zi + 1) - lat(xi, yi + 1, zi + 1)) * fx;
  float c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;                          // 0..1
}
inline float fbm(V3 p) { return (noise3(p.x, p.y, p.z) - 0.5f) + 0.5f * (noise3(p.x * 2.1f + 7.f, p.y * 2.1f, p.z * 2.1f) - 0.5f); }

// Tangential current on the shell (curl of a noise potential), evaluated at a unit direction.
V3 flow(V3 dir, float t) {
  V3 q = dir * NOISE_SCALE + V3{t * 0.06f, t * 0.04f, -t * 0.05f};
  const float e = 0.05f;
  V3 g{ fbm(q + V3{e, 0, 0}) - fbm(q - V3{e, 0, 0}),
        fbm(q + V3{0, e, 0}) - fbm(q - V3{0, e, 0}),
        fbm(q + V3{0, 0, e}) - fbm(q - V3{0, 0, e}) };
  V3 curl = cross(dir, g) * (1.f / (2.f * e));
  V3 drift = cross(V3{0.2f, 1.f, 0.3f}, dir) * 0.25f;
  return curl * 0.35f + drift;
}
inline float hueField(V3 p, float t) { return fminf(1.f, fmaxf(0.f, 0.5f + 1.6f * fbm(p * 1.6f + V3{t * 0.03f, -t * 0.02f, 11.f}))); }

// ---- view -------------------------------------------------------------------
float yaw = 0, tilt = 0.45f;
float m[9];
void buildView(float t) {
  yaw = t * 0.12f;
  tilt = 0.45f + 0.2f * sinf(t * 0.09f);
  float cy = cosf(yaw), sy = sinf(yaw), cx = cosf(tilt), sx = sinf(tilt);
  m[0] = cy;        m[1] = 0;   m[2] = sy;
  m[3] = sx * sy;   m[4] = cx;  m[5] = -sx * cy;
  m[6] = -cx * sy;  m[7] = sx;  m[8] = cx * cy;
}
inline V3 toView(V3 p) { return {m[0]*p.x + m[1]*p.y + m[2]*p.z, m[3]*p.x + m[4]*p.y + m[5]*p.z, m[6]*p.x + m[7]*p.y + m[8]*p.z}; }
inline V3 toWorld(V3 q) { return {m[0]*q.x + m[3]*q.y + m[6]*q.z, m[1]*q.x + m[4]*q.y + m[7]*q.z, m[2]*q.x + m[5]*q.y + m[8]*q.z}; }

// Touch (logical px) -> point on the visible hemisphere of the shell, or its rim.
bool predator = false;
V3   predW;
int  predSX, predSY;
void updatePredator(bool down, int tx, int ty) {
  predator = false;
  if (!down) return;
  float nx = (tx - CX) / (R * zoom), ny = -(ty - CY) / (R * zoom);
  float d2 = nx * nx + ny * ny;
  if (d2 > 1.6f * 1.6f) return;
  V3 q;
  if (d2 < 1.f) q = {nx, ny, sqrtf(1.f - d2)};
  else { float l = sqrtf(d2); q = {nx / l, ny / l, 0}; }
  q.x /= (1.f + PERSP * q.z); q.y /= (1.f + PERSP * q.z);
  q = norm(q);
  predW = toWorld(q);
  predator = true;
  predSX = tx; predSY = ty;
}

// ---- simulation ---------------------------------------------------------------
void simulate(float dt, float t) {
  for (auto& c : cells) { c.sumV = {0, 0, 0}; c.sumP = {0, 0, 0}; c.n = 0; c.flowDone = false; }

  for (int i = 0; i < N; ++i) {
    Fish& f = fish[i];
    Cell& c = cells[cellOf(norm(f.p), len(f.p))];
    c.sumV = c.sumV + f.v; c.sumP = c.sumP + f.p;
    if (c.n < CELL_CAP) c.idx[c.n] = i;
    c.n++;
  }
  const float sep2 = SEP_D * SEP_D;
  for (int i = 0; i < N; ++i) {
    Fish& f = fish[i];
    float r = len(f.p);
    V3 dir = f.p * (1.f / fmaxf(r, 1e-4f));
    Cell& c = cells[cellOf(dir, r)];
    // current: sampled once per occupied cell, kept tangential to the shell
    if (!c.flowDone) { c.flow = flow(norm(c.sumP), t); c.flowDone = true; }
    V3 desired = tangent(c.flow, dir) * W_FLOW;
    // separation: full 3-D push away from the nearest few in the cell
    int mcount = c.n < CELL_CAP ? c.n : CELL_CAP;
    for (int k = 0; k < mcount; ++k) {
      int j = c.idx[k]; if (j == i) continue;
      V3 d = f.p - fish[j].p;
      float d2 = dot(d, d);
      if (d2 < sep2 && d2 > 1e-8f) {
        float dl = sqrtf(d2);
        float k2 = 1.f - dl / SEP_D;                   // 0 at edge .. 1 overlapping
        desired = desired + d * (W_SEP * k2 / (dl * SEP_D));
      }
    }
    // alignment + cohesion in 3-D (radial component included: schools thicken/thin together)
    if (c.n > 1) {
      float inv = 1.f / c.n;
      desired = desired + c.sumV * inv * W_ALIGN;
      desired = desired + (c.sumP * inv - f.p) * (W_COHESE * 4.f);
    }
    desired = desired - f.p * W_GLOBAL;               // toward the sphere centre (origin)
    desired = desired + V3{srand1(), srand1(), srand1()} * W_JITTER;

    if (predator) {
      V3 d = f.p - predW;
      float dl = len(d);
      if (dl < FEAR_D) {
        float k = 1.f - dl / FEAR_D;                  // 0 at edge .. 1 on top of the finger
        desired = desired + norm(d) * (FEAR_K * (0.3f + k));
        if (k > f.panic) f.panic = k;
      }
    }
    f.panic *= expf(-dt * 1.2f);

    // steer toward the desired direction at cruise speed
    float speed = CRUISE * (1.f + 2.5f * f.panic);
    V3 want = norm(desired) * speed;
    f.v = f.v + (want - f.v) * fminf(1.f, TURN * dt * (1.f + 2.f * f.panic));
    float s = len(f.v);
    if (s > SPEED_MAX) f.v = f.v * (SPEED_MAX / s);
    else if (s < SPEED_MIN) f.v = f.v * (SPEED_MIN / fmaxf(s, 1e-4f));
    f.p = f.p + f.v * dt;
    r = len(f.p);
    if (r > R_MAX) {                                    // soft wall: slide along it, kill outward velocity
      f.p = f.p * (R_MAX / r);
      float vr = dot(f.v, dir);
      if (vr > 0) f.v = f.v - dir * vr;
    }
    f.hue += (hueField(dir, t) - f.hue) * fminf(1.f, dt * 2.f);
  }
}

void recordTrails() {
  for (auto& f : fish) {
    for (int i = TRAIL - 1; i > 0; --i) f.hist[i] = f.hist[i - 1];
    f.hist[0] = f.p;
  }
}

// ---- render ------------------------------------------------------------------
inline uint16_t rgb(int r, int g, int b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }

inline void project(V3 q, int& sx, int& sy) {
  float persp = 1.f + PERSP * q.z;
  sx = (int)(CX + R * zoom * q.x * persp + 0.5f);
  sy = (int)(CY - R * zoom * q.y * persp + 0.5f);
}

inline uint16_t trailColor(float hue, float bright) {
  float r = 40 + (255 - 40) * hue, g = 110 + (130 - 110) * hue, b = 255 + (30 - 255) * hue;
  return rgb((int)(r * bright), (int)(g * bright), (int)(b * bright));
}

// No depth shading: depth reads purely from size and draw order (back to front).
void drawFish(const Fish& f, V3 q) {
  float depth = fminf(1.f, fmaxf(0.f, q.z * 0.5f + 0.5f));
  int px, py; project(q, px, py);
  for (int i = 0; i < TRAIL; ++i) {
    V3 h = toView(f.hist[i]);
    int hx, hy; project(h, hx, hy);
    float fade = fminf(1.f, (1.15f - i / (float)TRAIL) * 1.1f);
    if (i == 0 && abs(hx - px) + abs(hy - py) > 40) break;
    frame.drawLine(px, py, hx, hy, trailColor(f.hue, fade));
    px = hx; py = hy;
  }
  int sx, sy; project(q, sx, sy);
  int size = SQ_MIN + (int)((SQ_MAX - SQ_MIN) * depth + 0.5f);
  int w = (int)(255 * fminf(1.f, 0.85f + f.panic * 0.5f));
  frame.drawRect(sx - size / 2, sy - size / 2, size, size, rgb(w, w, w));
}

// Counting sort by view depth into buckets, then draw back to front.
constexpr int ZB = 48;
V3      viewPos[N];
int16_t order[N];
int16_t bucketStart[ZB + 1];

void render(float t) {
  frame.fillScreen(TFT_BLACK);
  int counts[ZB] = {0};
  uint8_t bucket[N];
  for (int i = 0; i < N; ++i) {
    viewPos[i] = toView(fish[i].p);
    float z = fminf(R_MAX, fmaxf(-R_MAX, viewPos[i].z));
    int b = (int)((z + R_MAX) / (2.f * R_MAX) * (ZB - 1) + 0.5f);
    bucket[i] = b; counts[b]++;
  }
  bucketStart[0] = 0;
  for (int b = 0; b < ZB; ++b) bucketStart[b + 1] = bucketStart[b] + counts[b];
  int fill[ZB]; for (int b = 0; b < ZB; ++b) fill[b] = bucketStart[b];
  for (int i = 0; i < N; ++i) order[fill[bucket[i]]++] = i;
  for (int k = 0; k < N; ++k) drawFish(fish[order[k]], viewPos[order[k]]);
  if (predator) {
    frame.drawCircle(predSX, predSY, 7, rgb(120, 40, 40));
    frame.drawCircle(predSX, predSY, 8, rgb(60, 20, 20));
  }
  sliders::draw(frame);
  if (!ota::online()) frame.drawPixel(W - 2, H - 2, rgb(80, 80, 0));
  canvas::present();
}

uint32_t lastMs = 0, frames = 0, perfMs = 0;

}  // namespace

void setup() {
  Serial.setTxBufferSize(4096);
  Serial.begin(115200);
  delay(100);
  Serial.printf("\n[fish3d] %d fish on a %dx%d panel\n", N, W, H);
  canvas::begin();
  ota::begin();
  for (auto& f : fish) {
    V3 dir = randomOnSphere();
    f.p = dir * cbrtf(frand());                        // uniform in the ball
    f.v = norm({srand1(), srand1(), srand1()}) * CRUISE;
    f.panic = 0;
    f.hue = 0.5f;
    for (auto& h : f.hist) h = f.p;
  }
  static const sliders::Slider top[] = {
    {"sep", &W_SEP, 0.f, 20.f}, {"glob", &W_GLOBAL, 0.f, 4.f},
    {"coh", &W_COHESE, 0.f, 4.f}, {"flow", &W_FLOW, 0.f, 2.f},
  };
  static const sliders::Slider bottom = {"zoom", &zoom, 0.4f, 2.2f};
  sliders::begin(top, 4, &bottom);
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
  bool down = canvas::touch(tx, ty);
  buildView(t);
  bool onSlider = sliders::touch(down, tx, ty);
  updatePredator(down && !onSlider, tx, ty);
  simulate(dt, t);
  static int trailTick = 0;
  if (++trailTick >= TRAIL_EVERY) { trailTick = 0; recordTrails(); }
  render(t);

  frames++;
  if (now - perfMs > 5000) {
    Serial.printf("[fish3d] %.1f fps, heap=%u\n", frames * 1000.f / (now - perfMs), ESP.getFreeHeap());
    frames = 0; perfMs = now;
  }
}
