// fish: a school of hollow-square fish swimming over the surface of a sphere.
// Boids-lite (cell-averaged alignment + cohesion) riding a slowly drifting
// current field; a finger on the screen is a predator they scatter from.
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
constexpr float R          = fminf(W, H) * 0.28f;     // sphere radius, px
constexpr float CX         = W * 0.5f, CY = H * 0.5f;
constexpr float PERSP      = 0.22f;                    // 0 = orthographic
constexpr int   SQ_MIN     = 3;                        // hollow square, back of sphere
constexpr int   SQ_MAX     = (W >= 320) ? 6 : 5;       // ...front of sphere
constexpr float CRUISE     = 0.9f;                     // rad/s along the surface
constexpr float SPEED_MIN  = 0.4f, SPEED_MAX = 3.8f;
constexpr float TURN       = 3.0f;                     // how fast velocity chases desired
constexpr float W_FLOW     = 1.6f, W_ALIGN = 0.9f, W_COHESE = 0.35f, W_JITTER = 0.4f;
constexpr float R_MIN      = 0.78f, R_MAX = 1.30f;    // altitude limits (1 = nominal surface)
// live-tunable via the on-screen sliders
float R_SPRING = 0.6f;                                 // pull back toward the nominal surface
float R_ALIGN  = 1.2f;                                 // chase the cell's average altitude
float R_SEP    = 0.9f;                                 // crowded fish split into layers
float R_WANDER = 0.35f;                                // per-fish random altitude drift
float zoom     = 1.0f;                                 // screen radius multiplier
constexpr float W_SEP      = 3.0f;                     // neighbour avoidance
constexpr float SEP_R      = 0.09f;                    // radians; ~2.5 fish widths
constexpr int   CELL_CAP   = 10;                       // fish tracked per cell for separation
constexpr int   TRAIL      = 6;                        // history samples per fish
constexpr int   TRAIL_EVERY= 2;                        // frames between samples
constexpr float NOISE_SCALE= 2.2f;                     // flow-field lattice frequency on the unit sphere
constexpr float FEAR_R     = 0.55f;                    // predator radius, radians on sphere
constexpr float FEAR_K     = 6.0f;
constexpr int   LAT = 12, LON = 24;                    // flock cells

struct V3 { float x, y, z; };
inline V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 operator*(V3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline float len(V3 a) { return sqrtf(dot(a, a)); }
inline V3 norm(V3 a) { float l = len(a); return l > 1e-6f ? a * (1.f / l) : V3{0, 0, 1}; }
inline V3 tangent(V3 v, V3 p) { return v - p * dot(v, p); }   // strip radial component

struct Fish {
  V3    p;        // unit position on sphere
  V3    v;        // tangent velocity (rad/s)
  float panic;    // 0..1, decays
  float hue;      // 0 blue .. 1 orange, from the perlin field (trail colour)
  float r;        // altitude: distance from sphere centre (1 = nominal surface)
  float rv;       // radial velocity
  float rw;       // slow random-walk bias on altitude
  V3    hist[TRAIL];   // previous positions, newest first
};
Fish fish[N];

struct Cell { V3 sumV, sumP; float sumR; int n; int16_t idx[CELL_CAP]; V3 flow; bool flowDone; };
Cell cells[LAT * LON];

uint32_t rng = 0x9E3779B9u;
inline uint32_t xr() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
inline float frand() { return (xr() & 0xFFFFFF) / 16777216.f; }          // [0,1)
inline float srand1() { return frand() * 2.f - 1.f; }                     // [-1,1)

inline int cellOf(V3 p) {
  int la = (int)((p.z * 0.5f + 0.5f) * LAT); if (la >= LAT) la = LAT - 1;
  int lo = (int)((atan2f(p.y, p.x) + (float)M_PI) * (LON / (2.f * (float)M_PI))); if (lo >= LON) lo = LON - 1;
  return la * LON + lo;
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
// Two octaves, centred on 0.
inline float fbm(V3 p) { return (noise3(p.x, p.y, p.z) - 0.5f) + 0.5f * (noise3(p.x * 2.1f + 7.f, p.y * 2.1f, p.z * 2.1f) - 0.5f); }

// Current field on the sphere: curl of a scalar noise potential (gradient
// rotated 90 deg in the tangent plane) so fish stream along its contour lines,
// which wander everywhere instead of forming one ring. Drifts with time.
V3 flow(V3 p, float t) {
  V3 q = p * NOISE_SCALE + V3{t * 0.06f, t * 0.04f, -t * 0.05f};
  const float e = 0.05f;
  V3 g{ fbm(q + V3{e, 0, 0}) - fbm(q - V3{e, 0, 0}),
        fbm(q + V3{0, e, 0}) - fbm(q - V3{0, e, 0}),
        fbm(q + V3{0, 0, e}) - fbm(q - V3{0, 0, e}) };
  V3 curl = cross(p, g) * (1.f / (2.f * e));           // tangent by construction
  V3 drift = cross(V3{0.2f, 1.f, 0.3f}, p) * 0.25f;    // faint global swirl so nothing stalls
  return curl * 0.35f + drift;
}
// Colour field for trails (independent, slower).
inline float hueField(V3 p, float t) { return fminf(1.f, fmaxf(0.f, 0.5f + 1.6f * fbm(p * 1.6f + V3{t * 0.03f, -t * 0.02f, 11.f}))); }

// ---- view -------------------------------------------------------------------
float yaw = 0, tilt = 0.45f;
float m[9];                                            // world -> view rotation
void buildView(float t) {
  yaw = t * 0.12f;
  tilt = 0.45f + 0.2f * sinf(t * 0.09f);
  float cy = cosf(yaw), sy = sinf(yaw), cx = cosf(tilt), sx = sinf(tilt);
  // Rx(tilt) * Ry(yaw)
  m[0] = cy;        m[1] = 0;   m[2] = sy;
  m[3] = sx * sy;   m[4] = cx;  m[5] = -sx * cy;
  m[6] = -cx * sy;  m[7] = sx;  m[8] = cx * cy;
}
inline V3 toView(V3 p) { return {m[0]*p.x + m[1]*p.y + m[2]*p.z, m[3]*p.x + m[4]*p.y + m[5]*p.z, m[6]*p.x + m[7]*p.y + m[8]*p.z}; }
inline V3 toWorld(V3 q) { return {m[0]*q.x + m[3]*q.y + m[6]*q.z, m[1]*q.x + m[4]*q.y + m[7]*q.z, m[2]*q.x + m[5]*q.y + m[8]*q.z}; }

// Touch (logical px) -> point on the visible hemisphere, or rim if outside.
bool predator = false;
V3   predW;                                            // world coords
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
  // undo perspective roughly (front hemisphere is drawn larger)
  q.x /= (1.f + PERSP * q.z); q.y /= (1.f + PERSP * q.z);
  q = norm(q);
  predW = toWorld(q);
  predator = true;
  predSX = tx; predSY = ty;
}

inline uint16_t rgb(int r, int g, int b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }

// ---- simulation ---------------------------------------------------------------
void simulate(float dt, float t) {
  for (auto& c : cells) { c.sumV = {0, 0, 0}; c.sumP = {0, 0, 0}; c.sumR = 0; c.n = 0; c.flowDone = false; }
  for (int i = 0; i < N; ++i) {
    Fish& f = fish[i];
    Cell& c = cells[cellOf(f.p)];
    c.sumV = c.sumV + f.v; c.sumP = c.sumP + f.p; c.sumR += f.r;
    if (c.n < CELL_CAP) c.idx[c.n] = i;
    c.n++;
  }
  const float cosR = cosf(FEAR_R), cosSep = cosf(SEP_R);
  for (int i = 0; i < N; ++i) {
    Fish& f = fish[i];
    Cell& c = cells[cellOf(f.p)];
    // flow field sampled once per occupied cell (at its centroid), not per fish
    if (!c.flowDone) { c.flow = flow(norm(c.sumP), t); c.flowDone = true; }
    V3 desired = tangent(c.flow, f.p) * W_FLOW;
    // separation from the nearest few fish in the same cell
    float ra = 0;                                      // radial acceleration (boid-driven altitude)
    int m = c.n < CELL_CAP ? c.n : CELL_CAP;
    for (int k = 0; k < m; ++k) {
      int j = c.idx[k]; if (j == i) continue;
      float d = dot(f.p, fish[j].p);
      if (d > cosSep) {
        float k2 = (d - cosSep) / (1.f - cosSep);      // 0 at edge .. 1 overlapping
        desired = desired + tangent(f.p - fish[j].p, f.p) * (W_SEP * k2 / SEP_R);
        // too close in altitude as well -> split into layers (deterministic tie-break)
        float dr = f.r - fish[j].r;
        if (fabsf(dr) < 0.06f) dr = (i > j) ? 0.06f : -0.06f;
        ra += (dr > 0 ? 1.f : -1.f) * R_SEP * k2;
      }
    }
    if (c.n > 1) ra += (c.sumR / c.n - f.r) * R_ALIGN;   // schools rise and dive together
    ra += (1.f - f.r) * R_SPRING;
    f.rw += srand1() * dt * 0.8f; f.rw *= expf(-dt * 0.4f);
    ra += f.rw * R_WANDER;
    f.rv = (f.rv + ra * dt) * expf(-dt * 1.5f);
    f.r += f.rv * dt;
    if (f.r < R_MIN) { f.r = R_MIN; if (f.rv < 0) f.rv = 0; }
    if (f.r > R_MAX) { f.r = R_MAX; if (f.rv > 0) f.rv = 0; }
    if (c.n > 1) {
      float inv = 1.f / c.n;
      desired = desired + tangent(c.sumV * inv, f.p) * W_ALIGN;
      desired = desired + tangent(c.sumP * inv - f.p, f.p) * (W_COHESE * 4.f);
    }
    desired = desired + tangent({srand1(), srand1(), srand1()}, f.p) * W_JITTER;

    if (predator) {
      float d = dot(f.p, predW);
      if (d > cosR) {
        float k = (d - cosR) / (1.f - cosR);          // 0 at edge .. 1 on top of the finger
        V3 away = norm(tangent(f.p * d - predW, f.p));
        desired = desired + away * (FEAR_K * (0.3f + k));
        if (k > f.panic) f.panic = k;
      }
    }
    f.panic *= expf(-dt * 1.2f);

    float speed = CRUISE * (1.f + 2.5f * f.panic);
    V3 want = norm(tangent(desired, f.p)) * speed;
    f.v = f.v + (want - f.v) * fminf(1.f, TURN * dt * (1.f + 2.f * f.panic));
    f.v = tangent(f.v, f.p);
    float s = len(f.v);
    if (s > SPEED_MAX) f.v = f.v * (SPEED_MAX / s);
    else if (s < SPEED_MIN) f.v = f.v * (SPEED_MIN / fmaxf(s, 1e-4f));
    f.p = norm(f.p + f.v * dt);
    f.hue += (hueField(f.p, t) - f.hue) * fminf(1.f, dt * 2.f);
  }
}

void recordTrails() {
  for (auto& f : fish) {
    for (int i = TRAIL - 1; i > 0; --i) f.hist[i] = f.hist[i - 1];
    f.hist[0] = f.p * f.r;
  }
}

// ---- render ------------------------------------------------------------------

inline void project(V3 q, int& sx, int& sy) {
  float persp = 1.f + PERSP * q.z;
  sx = (int)(CX + R * zoom * q.x * persp + 0.5f);
  sy = (int)(CY - R * zoom * q.y * persp + 0.5f);
}

inline uint16_t trailColor(float hue, float bright) {
  // blue (40,110,255) -> orange (255,130,30)
  float r = 40 + (255 - 40) * hue, g = 110 + (130 - 110) * hue, b = 255 + (30 - 255) * hue;
  return rgb((int)(r * bright), (int)(g * bright), (int)(b * bright));
}

void drawFish(const Fish& f, bool frontPass) {
  V3 q = toView(f.p * f.r);
  if ((q.z >= 0) != frontPass) return;
  float depth = fminf(1.f, fmaxf(0.f, q.z * 0.5f + 0.5f));   // 0 back .. 1 front
  float vis = 0.10f + 0.90f * depth * depth;
  // trail: newest segment brightest, fading toward the tail
  int px, py; project(q, px, py);
  for (int i = 0; i < TRAIL; ++i) {
    V3 h = toView(f.hist[i]);
    int hx, hy; project(h, hx, hy);
    float fade = fminf(1.f, vis * (1.15f - i / (float)TRAIL) * 1.3f);
    if (i == 0 && abs(hx - px) + abs(hy - py) > 40) break;   // fresh spawn, no trail yet
    frame.drawLine(px, py, hx, hy, trailColor(f.hue, fade));
    px = hx; py = hy;
  }
  int sx, sy; project(q, sx, sy);
  int size = SQ_MIN + (int)((SQ_MAX - SQ_MIN) * depth + 0.5f);
  int w = (int)(255 * fminf(1.f, vis + f.panic * 0.5f));
  frame.drawRect(sx - size / 2, sy - size / 2, size, size, rgb(w, w, w));
}

void render(float t) {
  frame.fillScreen(TFT_BLACK);
  for (const auto& f : fish) drawFish(f, false);
  for (const auto& f : fish) drawFish(f, true);
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
  Serial.printf("\n[fish] %d fish on a %dx%d panel\n", N, W, H);
  canvas::begin();
  ota::begin();
  for (auto& f : fish) {
    f.p = randomOnSphere();
    f.v = norm(tangent({srand1(), srand1(), srand1()}, f.p)) * CRUISE;
    f.panic = 0;
    f.hue = 0.5f;
    f.r = 1.f;
    for (auto& h : f.hist) h = f.p;
  }
  static const sliders::Slider top[] = {
    {"ali", &R_ALIGN, 0.f, 3.f}, {"sep", &R_SEP, 0.f, 3.f},
    {"wan", &R_WANDER, 0.f, 1.5f}, {"spr", &R_SPRING, 0.f, 2.f},
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
    Serial.printf("[fish] %.1f fps, heap=%u\n", frames * 1000.f / (now - perfMs), ESP.getFreeHeap());
    frames = 0; perfMs = now;
  }
}
