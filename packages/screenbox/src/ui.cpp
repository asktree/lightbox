// Retro-future wheel: an orthographic 3D scene whose floor is the HSV colour
// wheel. Each light is an orb floating above the floor — x/y = hue/saturation
// (same geometry as the web ColorWheel), height = brightness — with a marching
// dotted line projecting it down onto the wheel. Continuous ~30 fps render.
#include "ui.h"
#include <vector>
#include <algorithm>
#include <math.h>
#include "board.h"
#include "net.h"
#include SCREENBOX_LAB_HEADER

namespace ui {
namespace {

board::Display lcd;
LGFX_Sprite    frame(&lcd);      // full-screen back buffer (PSRAM)
// Unsquashed circular wheel (PSRAM). The dormant look is carved out of it at
// runtime using the labyrinth distance field: lines of uniform thickness.
LGFX_Sprite    wheelSolid(&lcd);
LGFX_Sprite    floorCache(&lcd);  // last composite; reused while nothing changes (PSRAM)
uint32_t       floorSig = 0;

// Band rendering: the frame is drawn in BANDS horizontal strips through one
// internal-RAM sprite (fast to draw into, DMA to push) so big screens don't
// have to stream a whole PSRAM frame buffer every frame.
constexpr int BANDS  = (board::LCD_W * board::LCD_H * 2 > 200000) ? 2 : 1;
constexpr int BAND_H = board::LCD_H / BANDS;
int viewY = 0;                    // screen y of the current band's top row

// Drawing goes through this so every call is offset into the current band.
struct Canvas {
  LGFX_Sprite& s;
  void fillRect(int x, int y, int w, int h, uint32_t c)       { s.fillRect(x, y - viewY, w, h, c); }
  void drawRect(int x, int y, int w, int h, uint32_t c)       { s.drawRect(x, y - viewY, w, h, c); }
  void fillRoundRect(int x, int y, int w, int h, int r, uint32_t c) { s.fillRoundRect(x, y - viewY, w, h, r, c); }
  void drawRoundRect(int x, int y, int w, int h, int r, uint32_t c) { s.drawRoundRect(x, y - viewY, w, h, r, c); }
  void drawPixel(int x, int y, uint32_t c)                    { s.drawPixel(x, y - viewY, c); }
  void drawFastVLine(int x, int y, int h, uint32_t c)         { s.drawFastVLine(x, y - viewY, h, c); }
  void fillCircle(int x, int y, int r, uint32_t c)            { s.fillCircle(x, y - viewY, r, c); }
  void drawEllipse(int x, int y, int rx, int ry, uint32_t c)  { s.drawEllipse(x, y - viewY, rx, ry, c); }
  void fillArc(int x, int y, int r0, int r1, float a0, float a1, uint32_t c) { s.fillArc(x, y - viewY, r0, r1, a0, a1, c); }
  void fillEllipseArc(int x, int y, int rx0, int rx1, int ry0, int ry1, float a0, float a1, uint32_t c) { s.fillEllipseArc(x, y - viewY, rx0, rx1, ry0, ry1, a0, a1, c); }
  void drawString(const char* str, int x, int y)              { s.drawString(str, x, y - viewY); }
  void setFont(const lgfx::IFont* f)                          { s.setFont(f); }
  void setTextSize(float sz)                                  { s.setTextSize(sz); }
  void setTextDatum(textdatum_t d)                            { s.setTextDatum(d); }
  void setTextColor(uint32_t c)                               { s.setTextColor(c); }
};
Canvas canvas{frame};

constexpr int W = board::LCD_W, H = board::LCD_H;
constexpr float SX = W / 240.f, SY = H / 320.f;   // layout was designed on 240x320
constexpr int TS = board::TEXT_SCALE;
#define UI_FONT board::uiFont()

// --- scene / projection ------------------------------------------------------
// World: x right, y "into the screen" (toward the top), z up. Orthographic
// camera pitched so the floor squashes vertically by SQUASH.
constexpr int   R      = board::WHEEL_R;      // wheel radius, world units == px
constexpr float SQUASH = 0.72f;
constexpr int   RX = R, RY = (int)(R * SQUASH + 0.5f);
constexpr int   CX = W / 2, CY = (int)(218 * SY);   // floor centre on screen
constexpr int   ZMAX = (int)(78 * SY);              // orb height at brightness 100
constexpr int   ORB_R = (int)(10 * SX), HIT_R = (int)(24 * SX);   // ORB_R = half-size when awake; 30 % smaller dormant

constexpr int BAR_X = (int)(22 * SX), BAR_Y = (int)(14 * SY), BAR_W = (int)(170 * SX), BAR_H = (int)(6 * SY);
constexpr int READOUT_Y = (int)(34 * SY);
constexpr int LINE_H = (int)(11 * SY);            // readout line spacing
constexpr int STATUS_Y = H - 5;
constexpr uint32_t HOLD_GRACE_MS  = 500;    // hold this long before the ring starts
constexpr uint32_t HOLD_CHARGE_MS = 500;    // ring fill time -> toggle
constexpr uint32_t SELECT_TIMEOUT_MS = 5000;

// --- palette -----------------------------------------------------------------
constexpr uint32_t C_BG      = 0x000000;  // true black: the LCD renders zinc-950 with a purple cast
constexpr uint32_t C_ZINC800 = 0x27272a;
constexpr uint32_t C_ZINC700 = 0x3f3f46;
constexpr uint32_t C_ZINC500 = 0x71717a;
constexpr uint32_t C_ZINC400 = 0xa1a1aa;
constexpr uint32_t C_ZINC50  = 0xfafafa;
constexpr uint32_t C_PURPLE  = 0xa855f7;
constexpr uint32_t C_WHITE   = 0xffffff;
constexpr uint32_t C_GREEN   = 0x22c55e;
constexpr uint32_t C_RED     = 0xf87171;

// --- ambience mode -----------------------------------------------------------
// 'color' = the HSV wheel. 'normal' = a blackbody-radiator kelvin bar: CT-mode
// lights ride it as pins (Hue renders CT with its warm-white diodes). The
// toggle also switches the curtains (soap <-> twinkle) via the server.
bool normalMode = false;
// 1000K floor: CT hardware stops at 2000K; below that the server emulates the
// blackbody chromaticity with the color engine (ember/coal territory).
constexpr int KELVIN_MIN = 1000, KELVIN_MAX = 6500;
float curtainsKf = 2900.f;    // the curtains' twinkle color (bar position)
constexpr int MODE_R  = (int)(9 * SX);              // circular mode button,
constexpr int MODE_CX = W - 12;                     // above the online dot
constexpr int MODE_CY = STATUS_Y - (int)(26 * SY);
// Vertical kelvin bar along the left edge (cool at the top, warm at the
// bottom), and the global-shift track mirrored on the right.
constexpr int KBV_X  = (int)(30 * SX);              // bar centerline (screen x)
constexpr int KBV_HW = (int)(9 * SX);               // bar half-width
constexpr int KBV_Y0 = (int)(48 * SY);              // top = cool end
constexpr int KBV_Y1 = H - (int)(30 * SY);          // bottom = warm end
constexpr int GK_X   = W - (int)(30 * SX);          // global-shift track x
// In normal mode a pin's distance to the RIGHT of the bar = its brightness
// (the vertical-bar analogue of the wheel's floating height).
constexpr int KB_RANGE = (int)(110 * SX);           // offset at 100%

// Thermal idle: untouched for a while -> dim the backlight, drop the frame
// rate, and downclock the CPU. Any touch (or a remote light change, briefly)
// restores full speed. The panel otherwise renders 30fps at 240MHz forever,
// which is most of why it runs hot.
constexpr uint32_t IDLE_AFTER_MS  = 60000;
constexpr uint32_t REMOTE_WAKE_MS = 10000;
bool     idleCool = false;
uint32_t lastRemoteMs = 0;

// --- state -------------------------------------------------------------------
struct Orb {
  String id, name;
  int h = 0, s = 0, bri = 0;
  float hf = 0, sf = 0;            // unrounded hue/sat (drag smoothness); h/s are what we send
  int kelvin = 2700; float kf = 2700.f;   // CT position for normal mode
  bool on = false;
  uint32_t color = 0;
  float x = 0, y = 0, z = 0;       // current (animated) world position
  float tx = 0, ty = 0, tz = 0;    // targets
  float phase = 0;                 // idle bob phase
  bool fresh = true;
};
std::vector<Orb> orbs;
std::vector<net::Light> lights;
uint32_t seenVersion = 0xffffffff;
int offlineCount = 0;

String selectedId;
enum class Hold { None, Orb, Bar, Floor, Rim, GlobalK };
Hold     hold = Hold::None;
String   holdId;
bool     dragging = false, longFired = false;
int      downX = 0, downY = 0;
float    grabDX = 0, grabDY = 0;  // finger-to-orb offset at grab
uint32_t downMs = 0;
uint32_t lastInteractMs = 0;
bool     wasTouched = false;
uint32_t lastFrameMs = 0;

struct Ratio { String id; float ratio; };
std::vector<Ratio> barRatios;
bool barSingle = false;                           // bar drag targets the selected light only
constexpr int BAR_DROP = (int)(5 * SY);           // the per-light slider sits this far below the global one
int curtainsBri = 78;                             // twinkle val as 0-100 (~200/255)

// --- wheel rotation (grab the bottom rim and turn the dial) -------------------
// wheelRot = how far the disc is turned: hue h is drawn at angle h + wheelRot.
float    wheelRot = 0.f;
enum class RotPhase { Idle, Dragging, Settling, Returning };
RotPhase rotPhase = RotPhase::Idle;
uint32_t rotPhaseMs = 0;
float    rotGrabAngle = 0.f, rotAtGrab = 0.f, rotReturnFrom = 0.f;
float    rimTouchAngle = 0.f;                     // for the rim highlight
struct RotOrb { String id; float angle0; };       // screen angle of each orb at grab
std::vector<RotOrb> rotOrbs;
constexpr uint32_t ROT_SETTLE_MS = 500, ROT_RETURN_MS = 650;
constexpr float RIM_IN = 0.80f, RIM_OUT = 1.18f;  // grab band, in wheel radii

// --- floor "wake" state --------------------------------------------------------
float    floorFill = 0.f;                         // 0 = dormant lines, 1 = solid
constexpr uint32_t FLOOR_AWAKE_MS = 1200;         // stays solid this long after the last touch
constexpr float THICK_OUT = 36.f * SX;            // lines are thickest at a light, easing out (cubic) to normal by THICK_OUT
// labyrinth line half-widths (px): dormant, near a light, fully awake (gaps closed)
constexpr float LINE_THIN = 0.55f;
constexpr float SLIVER_HALF = 0.5f;               // black "inverse path" left along gap centre-lines when awake
uint32_t renderAccumUs = 0, renderFrames = 0;

struct Ripple { float wx, wy; uint32_t start; uint32_t color; };
std::vector<Ripple> ripples;

// labels are collected while drawing orbs and painted afterwards, on top
struct Label { int x, y; String text; uint32_t color; float alpha; };
std::vector<Label> labels;


// --- dithered fades ----------------------------------------------------------
// Text doesn't pop in and out: it dissolves through a 4x4 Bayer pattern.
LGFX_Sprite scratch(&lcd);          // small internal-RAM sprite for glyph masks
constexpr int SCRATCH_W = 300, SCRATCH_H = 20;
const uint8_t BAYER[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

struct Fader {
  float a = 0.f;
  // ease toward target; ~250 ms to settle
  void update(bool target, float dt) { a += ((target ? 1.f : 0.f) - a) * fminf(1.f, dt * 9.f); if (fabsf(a - (target ? 1.f : 0.f)) < 0.01f) a = target ? 1.f : 0.f; }
  float alpha() const { return a; }
  bool visible() const { return a > 0.02f; }
};
Fader namesFader, readoutFader, statusFader, roomFader;
String lastStatusText;

// Draw text through a Bayer mask at `alpha` (0..1). Pattern is anchored to the
// screen so it stays still while the text fades.
void ditherText(int x, int y, const char* s, uint32_t color, textdatum_t datum, float alpha, bool shadow) {
  if (alpha <= 0.02f) return;
  const int level = (int)(alpha * 16.f + 0.5f);
  scratch.setFont(UI_FONT);
  scratch.setTextSize(TS);
  int w = scratch.textWidth(s) + 2, h = scratch.fontHeight() + 2;
  if (w > SCRATCH_W) w = SCRATCH_W;
  scratch.fillRect(0, 0, w, h, 0);
  scratch.setTextDatum(textdatum_t::top_left);
  scratch.setTextColor(0xFFFFFF);
  scratch.drawString(s, 1, 1);
  int ox = 0, oy = 0;                               // datum -> top-left offset
  switch (datum) {
    case textdatum_t::top_center:    ox = w / 2; break;
    case textdatum_t::bottom_left:   oy = h; break;
    case textdatum_t::bottom_center: ox = w / 2; oy = h; break;
    case textdatum_t::bottom_right:  ox = w; oy = h; break;
    case textdatum_t::middle_left:   oy = h / 2; break;
    default: break;
  }
  const int X0 = x - ox, Y0 = y - oy;
  for (int py = 0; py < h; py++) {
    for (int px = 0; px < w; px++) {
      if (!scratch.readPixel(px, py)) continue;
      int sx = X0 + px, sy = Y0 + py;
      if (level >= 16 || BAYER[sy & 3][sx & 3] < level) {
        if (shadow) canvas.drawPixel(sx + 1, sy + 1, 0x000000);
        canvas.drawPixel(sx, sy, color);
      }
    }
  }
}

// --- maths -------------------------------------------------------------------
uint32_t hsvToRgb888(float h, float s, float v) {
  s /= 100.f; v /= 100.f;
  float c = v * s, hp = fmodf(h, 360.f) / 60.f, x = c * (1 - fabsf(fmodf(hp, 2) - 1));
  float r = 0, g = 0, b = 0;
  if (hp < 1)      { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else             { r = c; b = x; }
  float m = v - c;
  return ((uint32_t)roundf((r + m) * 255) << 16) | ((uint32_t)roundf((g + m) * 255) << 8) | (uint32_t)roundf((b + m) * 255);
}

uint32_t blend(uint32_t a, uint32_t b, float t) {   // a*(1-t) + b*t
  uint8_t r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  uint8_t g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  uint8_t bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (r << 16) | (g << 8) | bl;
}

// hue/sat -> world floor coords (web hsToPosition, centred)
void hsToWorldF(float h, float s, float& wx, float& wy) {
  float a = (h - 90.f) * (float)M_PI / 180.f, d = s / 100.f * R;
  wx = d * cosf(a); wy = d * sinf(a);
}
void hsToWorld(int h, int s, float& wx, float& wy) { hsToWorldF(h, s, wx, wy); }
void worldToHsF(float wx, float wy, float& h, float& s) {
  float dist = sqrtf(wx * wx + wy * wy);
  float ang = atan2f(wy, wx) * 180.f / (float)M_PI + 90.f;
  h = fmodf(fmodf(ang, 360.f) + 360.f, 360.f);
  s = fminf(100.f, dist / R * 100.f);
}
void worldToHs(float wx, float wy, int& h, int& s) {
  float dist = sqrtf(wx * wx + wy * wy);
  float ang = atan2f(wy, wx) * 180.f / (float)M_PI + 90.f;
  h = (int)roundf(fmodf(fmodf(ang, 360.f) + 360.f, 360.f)) % 360;
  s = (int)roundf(fminf(100.f, dist / R * 100.f));
}
inline int   sx(float wx)           { return CX + (int)roundf(wx); }
inline int   sy(float wy, float z)  { return CY + (int)roundf(wy * SQUASH - z); }

// Tanner Helland kelvin -> RGB approximation (same one the web KelvinBar uses).
uint32_t kelvinToRgb888(float kelvin) {
  float t = fminf((float)KELVIN_MAX, fmaxf((float)KELVIN_MIN, kelvin)) / 100.f;
  float r, g, b;
  if (t <= 66.f) {
    r = 255.f;
    g = 99.47f * logf(t) - 161.12f;
    b = t <= 19.f ? 0.f : 138.52f * logf(t - 10.f) - 305.04f;
  } else {
    r = 329.7f * powf(t - 60.f, -0.1332f);
    g = 288.12f * powf(t - 60.f, -0.0755f);
    b = 255.f;
  }
  auto c8 = [](float v) { return (uint32_t)fmaxf(0.f, fminf(255.f, roundf(v))); };
  return (c8(r) << 16) | (c8(g) << 8) | c8(b);
}
// kelvin <-> bar position (screen y; cool at the top, warm at the bottom).
// The bar is linear in MIRED (1e6/K), the perceptually-uniform CCT scale —
// linear-in-kelvin crams all the visible change into the warm end, which made
// low-range drags feel like big steps.
constexpr float MIRED_WARM = 1e6f / KELVIN_MIN;   // bottom end
constexpr float MIRED_COOL = 1e6f / KELVIN_MAX;   // top end
float yToMired(float y) {
  float f = fmaxf(0.f, fminf(1.f, (y - KBV_Y0) / (float)(KBV_Y1 - KBV_Y0)));
  return MIRED_COOL + f * (MIRED_WARM - MIRED_COOL);
}
float miredToY(float m) {
  float f = (m - MIRED_COOL) / (MIRED_WARM - MIRED_COOL);
  return KBV_Y0 + fmaxf(0.f, fminf(1.f, f)) * (KBV_Y1 - KBV_Y0);
}
float yToKelvin(float y) { return 1e6f / yToMired(y); }
float kelvinToY(float k) { return miredToY(1e6f / fmaxf(1.f, k)); }

// Where an orb sits: on the vertical kelvin bar in normal mode, else on the
// (possibly rotated) wheel by hue/sat.
void orbWorld(const Orb& o, float& wx, float& wy) { if (normalMode) { wx = KBV_X - CX; wy = (kelvinToY(o.kf) - CY) / SQUASH; return; } hsToWorldF(o.hf, o.sf, wx, wy); float a = wheelRot * (float)M_PI / 180.f; float c = cosf(a), s = sinf(a); float rx = wx * c - wy * s, ry = wx * s + wy * c; wx = rx; wy = ry; }
float normDeg(float d) { d = fmodf(d, 360.f); if (d < 0) d += 360.f; return d; }
float normDegSigned(float d) { d = normDeg(d); return d > 180.f ? d - 360.f : d; }
float easeInOut(float t) { t = fmaxf(0.f, fminf(1.f, t)); return t < 0.5f ? 2 * t * t : 1 - powf(-2 * t + 2, 2) / 2; }

Orb* findOrb(const String& id) { for (auto& o : orbs) if (o.id == id) return &o; return nullptr; }
int maxBrightness() { int m = 0; for (auto& l : lights) if (l.on && l.reachable) m = max(m, l.brightness); return m; }

// --- sync from net -----------------------------------------------------------
void syncOrbs() {
  lights = net::lights();
  offlineCount = 0;
  std::vector<Orb> next;
  for (auto& l : lights) {
    if (!l.reachable) { offlineCount++; continue; }
    // color mode shows color-capable lights on the wheel; normal mode shows
    // temperature-capable lights on the kelvin bar
    if (normalMode ? !l.canTemp : !l.canColor) continue;
    Orb o;
    if (Orb* prev = findOrb(l.id)) o = *prev;
    else { o.id = l.id; o.phase = (float)(rand() % 628) / 100.f; o.fresh = true; }
    o.name = l.name; o.h = l.h; o.s = l.s; o.hf = l.h; o.sf = l.s; o.bri = l.brightness; o.on = l.on;
    if (l.hasTemp) { o.kelvin = l.temperature; o.kf = l.temperature; }
    o.color = normalMode ? kelvinToRgb888(o.kf) : hsvToRgb888(l.h, l.s, 100);
    orbWorld(o, o.tx, o.ty);
    // z is the brightness offset: floating height on the wheel, distance to
    // the right of the bar in normal mode (drawOrb rotates it there).
    o.tz = !l.on ? 0 : l.brightness / 100.f * (normalMode ? KB_RANGE : ZMAX);
    if (o.fresh) { o.x = o.tx; o.y = o.ty; o.z = -ORB_R * 2; o.fresh = false; }   // new orbs rise up from below
    next.push_back(o);
  }
  // The curtains ride the bar too (normal mode only): a pseudo-orb whose
  // position is the twinkle routine's blackbody color, not a lightbox light.
  if (normalMode) {
    Orb o;
    if (Orb* prev = findOrb("curtains")) o = *prev;
    else { o.id = "curtains"; o.phase = (float)(rand() % 628) / 100.f; o.fresh = true; }
    o.name = "curtains"; o.on = true; o.bri = curtainsBri;
    o.kf = curtainsKf; o.kelvin = (int)roundf(curtainsKf);
    o.color = kelvinToRgb888(o.kf);
    orbWorld(o, o.tx, o.ty);
    o.tz = curtainsBri / 100.f * KB_RANGE;   // twinkle brightness = distance right
    if (o.fresh) { o.x = o.tx; o.y = o.ty; o.z = -ORB_R * 2; o.fresh = false; }
    next.push_back(o);
  }
  orbs = next;
}

// --- floor -------------------------------------------------------------------
// Base wheel colour at unit-disc coords (u right, v down). V=88 so orbs pop.
uint32_t wheelHue(float u, float v, float dist, float ang, float value) {
  return hsvToRgb888(ang, dist * 100.f, value);
}

// One solid wheel pixel.
uint32_t floorColor(float u, float v, float pxPerUnit) {
  float dist = sqrtf(u * u + v * v);
  if (dist > 1.f) return C_BG;
  float ang = atan2f(v, u) * 180.f / (float)M_PI + 90.f;
  if (ang < 0) ang += 360.f;
  uint32_t c = hsvToRgb888(ang, dist * 100.f, 92.f);
  if (dist < 0.10f) c = blend(c, C_WHITE, 0.6f * (1.f - dist / 0.10f));   // centre bloom
  float rimPx = (1.f - dist) * pxPerUnit;                                  // anti-aliased rim
  if (rimPx < 1.f) c = blend(C_BG, c, rimPx);
  return c;
}

void buildWheelLayer(LGFX_Sprite& s) {
  const int D = R * 2;
  s.setColorDepth(16);
  s.setPsram(true);
  s.createSprite(D, D);
  for (int y = 0; y < D; y++)
    for (int x = 0; x < D; x++)
      s.drawPixel(x, y, floorColor((x + 0.5f - R) / R, (y + 0.5f - R) / R, R));
}

void buildFloor() {
  buildWheelLayer(wheelSolid);
  static_assert(LAB_N == R * 2, "labyrinth field must match the wheel sprite size");
  floorCache.setColorDepth(16);
  floorCache.setPsram(true);
  floorCache.createSprite(RX * 2, RY * 2);
  floorCache.fillScreen(C_BG);
}

// Composite the wheel into `frame`: rotate-then-squash sampling of the three
// layers, choosing per pixel by distance to the nearest light's floor point
// and the global wake level (Bayer-dithered). Hot loop: integer fixed-point.
// Signature of everything that changes the whole disc (not orb positions).
uint32_t floorGlobalSig() {
  uint32_t h = 2166136261u;
  auto mix = [&](int v) { h ^= (uint32_t)v; h *= 16777619u; };
  mix((int)(floorFill * 64.f + 0.5f)); mix((int)(wheelRot * 4.f)); mix((int)orbs.size());
  return h;
}
struct OrbPos { int x, y; };
std::vector<OrbPos> prevOrbPos;

// Copy the cached composite (disc rows only) into the frame.
void pushFloorCache() {
  const uint16_t* src = (const uint16_t*)floorCache.getBuffer();
  uint16_t* dst = (uint16_t*)frame.getBuffer();
  const int CW = RX * 2;
  const float R2in = (R - 1.5f) * (R - 1.5f);
  for (int y = max(CY - RY, viewY); y < min(CY + RY, viewY + BAND_H); y++) {
    float v = (y + 0.5f - CY) / SQUASH;
    float rem = R2in - v * v;
    if (rem <= 0) continue;
    int hw = (int)sqrtf(rem);
    int xl = max(CX - RX, CX - hw), xr = min(CX + RX - 1, CX + hw);
    memcpy(dst + (y - viewY) * W + xl, src + (y - (CY - RY)) * CW + (xl - (CX - RX)), (xr - xl + 1) * 2);
  }
}

// Composite the wheel: rotate-then-squash sampling of the solid wheel, carved
// into labyrinth lines whose half-width T varies per pixel:
//   dormant -> LINE_THIN; near a light or when awake -> wide enough to close
//   the gaps, leaving only the black inverse path. Edges Bayer-dithered.
__attribute__((optimize("O2"))) void compositeRegion(int y0, int y1, int x0, int x1) {
  const uint16_t* solid = (const uint16_t*)wheelSolid.getBuffer();
  uint16_t* dst = (uint16_t*)floorCache.getBuffer();
  const int CW = RX * 2;
  const int D = R * 2;
  const float a = wheelRot * (float)M_PI / 180.f;
  const int32_t c16 = (int32_t)(cosf(a) * 65536.f), s16 = (int32_t)(sinf(a) * 65536.f);
  const uint16_t bg565 = frame.color565((C_BG >> 16) & 255, (C_BG >> 8) & 255, C_BG & 255);

  // line half-width in field units (1/16 px): T_FULL closes every gap
  const float T_FULL = LAB_DMAX + 1.f;
  const float ease = floorFill * floorFill * (3.f - 2.f * floorFill);          // smoothstep
  const int tBase = (int)((LINE_THIN + (T_FULL - LINE_THIN) * ease) * LAB_SCALE);
  const int tFull = (int)(T_FULL * LAB_SCALE);
  const int sliver16Half = (int)(SLIVER_HALF * LAB_SCALE);
  const bool fullyAwake = tBase >= tFull;

  int ox[12], oy[12]; int n = 0;
  for (auto& o : orbs) if (n < 12) { ox[n] = (int)lroundf(o.x); oy[n] = (int)lroundf(o.y); n++; }
  const int tPeak = tFull - 1;                     // thick enough to close the gaps (the sliver stays)
  const int to2 = (int)(THICK_OUT * THICK_OUT);
  const int R2in = (int)((R - 1.5f) * (R - 1.5f));

  for (int y = max(y0, CY - RY); y < min(y1, CY + RY); y++) {
    const float vf = (y + 0.5f - CY) / SQUASH;
    const int v = (int)lroundf(vf);
    const int32_t vs = (int32_t)(vf * 65536.f);
    const uint8_t* brow = BAYER[y & 3];
    uint16_t* drow = dst + (y - (CY - RY)) * CW - (CX - RX);   // indexed by screen x below

    int spanL = 1 << 30, spanR = -(1 << 30);
    for (int i = 0; i < n; i++) {
      int dy = v - oy[i]; int rem = to2 - dy * dy;
      if (rem < 0) continue;
      int hw = (int)sqrtf((float)rem);
      spanL = min(spanL, ox[i] - hw); spanR = max(spanR, ox[i] + hw);
    }

    for (int x = max(x0, CX - RX); x < min(x1, CX + RX); x++) {
      const int u = x - CX;
      if (u * u + v * v > R2in) continue;
      const int32_t uf = ((int32_t)u << 16) + 32768;
      const int sx = (int)(((int64_t)uf * c16 + (int64_t)vs * s16) >> 32) + R;
      const int sy = (int)(((int64_t)vs * c16 - (int64_t)uf * s16) >> 32) + R;
      if ((unsigned)sx >= (unsigned)D || (unsigned)sy >= (unsigned)D) continue;
      const int idx = sy * D + sx;
      const int b = brow[x & 3];
      // the inverse path: never painted (except inside a dropper porthole)
      const int sliver16 = (int)pgm_read_byte(&LAB_GAPD[idx]) - sliver16Half + 8;   // 0..16 over one px
      if (fullyAwake) { drow[x] = (sliver16 > 16 || (sliver16 > 0 && b < sliver16)) ? solid[idx] : bg565; continue; }

      // per-pixel half-width
      int T = tBase;
      if (u >= spanL && u <= spanR) {
        int d2 = 1 << 30;
        for (int i = 0; i < n; i++) { int dx = u - ox[i], dy = v - oy[i]; int q = dx * dx + dy * dy; if (q < d2) d2 = q; }
        if (d2 < to2) { float tt = 1.f - sqrtf((float)d2) / THICK_OUT; tt = tt * tt * tt; T = max(T, tBase + (int)((tPeak - tBase) * tt)); }   // ease-out (cubic)
      }
      // coverage: dist <= T and outside the inverse path, anti-aliased over 1 px, Bayer-dithered
      const int d16 = (int)pgm_read_byte(&LAB_DIST[idx]);
      int cover16 = min(T - d16 + 8, sliver16);                 // 0..16 over one px
      drow[x] = (cover16 > 16 || (cover16 > 0 && b < cover16)) ? solid[idx] : bg565;
    }
  }
}

void updateFloorCache() {
  uint32_t sig = floorGlobalSig();
  std::vector<OrbPos> cur; cur.reserve(orbs.size());
  for (auto& o : orbs) cur.push_back({(int)lroundf(o.x), (int)lroundf(o.y)});
  if (sig != floorSig || prevOrbPos.size() != cur.size()) {
    compositeRegion(0, H, 0, W);                          // everything changed
  } else {
    // only orbs moved: recompose the patches around old + new positions
    const int pad = (int)THICK_OUT + 2;
    for (size_t i = 0; i < cur.size(); i++) {
      if (cur[i].x == prevOrbPos[i].x && cur[i].y == prevOrbPos[i].y) continue;
      int ux0 = min(cur[i].x, prevOrbPos[i].x) - pad, ux1 = max(cur[i].x, prevOrbPos[i].x) + pad;
      int vy0 = min(cur[i].y, prevOrbPos[i].y) - pad, vy1 = max(cur[i].y, prevOrbPos[i].y) + pad;
      compositeRegion(CY + (int)floorf(vy0 * SQUASH) - 1, CY + (int)ceilf(vy1 * SQUASH) + 2, CX + ux0, CX + ux1 + 1);
    }
  }
  floorSig = sig; prevOrbPos = cur;
}

// --- drawing -----------------------------------------------------------------
void text(int x, int y, const char* s, uint32_t c, textdatum_t d = textdatum_t::top_left) {
  canvas.setFont(UI_FONT);
  canvas.setTextSize(TS);
  canvas.setTextDatum(d);
  canvas.setTextColor(c);
  canvas.drawString(s, x, y);
}
void shadowText(int x, int y, const char* s, uint32_t c, textdatum_t d) {
  text(x + 1, y + 1, s, 0x000000, d);
  text(x, y, s, c, d);
}

void drawBar(uint32_t now) {
  Orb* sel = findOrb(selectedId);
  const bool single = sel != nullptr;
  const bool active = hold == Hold::Bar;
  char buf[8];

  // global bar (greyed out and inert while a light is selected)
  {
    int m = maxBrightness();
    int fillW = BAR_W * m / 100;
    canvas.fillRoundRect(BAR_X, BAR_Y, BAR_W, BAR_H, BAR_H / 2, single ? blend(C_BG, C_ZINC800, 0.6f) : C_ZINC800);
    for (int i = 1; i < 10; i++) canvas.drawFastVLine(BAR_X + BAR_W * i / 10, BAR_Y + BAR_H + 2, 2, single ? blend(C_BG, C_ZINC700, 0.5f) : C_ZINC700);
    if (fillW > 0) canvas.fillRoundRect(BAR_X, BAR_Y, max(fillW, BAR_H), BAR_H, BAR_H / 2, single ? C_ZINC700 : blend(C_ZINC50, C_PURPLE, 0.25f));
    if (!single) {
      int tx = BAR_X + fillW;
      canvas.fillRoundRect(tx - 2, BAR_Y - 4, 4, BAR_H + 8, 2, active ? C_PURPLE : C_WHITE);
      snprintf(buf, sizeof buf, "%d%%", m);
      text(BAR_X + BAR_W + 8, BAR_Y + BAR_H / 2, buf, active ? C_WHITE : C_ZINC400, textdatum_t::middle_left);
    }
  }
  text(BAR_X, BAR_Y - 2, "LEVEL", C_ZINC500, textdatum_t::bottom_left);

  // per-light slider, overlapping just below (the curtains pin gets one too —
  // it drives the twinkle routine's brightness)
  if (single) {
    int y = BAR_Y + BAR_DROP;
    int fillW = BAR_W * sel->bri / 100;
    canvas.fillRoundRect(BAR_X, y, BAR_W, BAR_H, BAR_H / 2, C_ZINC800);
    if (fillW > 0) canvas.fillRoundRect(BAR_X, y, max(fillW, BAR_H), BAR_H, BAR_H / 2, sel->on ? sel->color : C_ZINC700);
    int tx = BAR_X + fillW;
    canvas.fillRoundRect(tx - 2, y - 4, 4, BAR_H + 8, 2, active ? C_PURPLE : C_WHITE);
    snprintf(buf, sizeof buf, "%d%%", sel->bri);
    text(BAR_X + BAR_W + 8, y + BAR_H / 2, buf, active ? C_WHITE : C_ZINC400, textdatum_t::middle_left);
  }
}

String lastReadoutId;   // keep showing the last orb while it fades out
Fader rotFader; float rotShown = 0.f;
void drawRotReadout() {
  if (!rotFader.visible()) return;
  char buf[24]; snprintf(buf, sizeof buf, "HUE %+d", (int)roundf(-normDegSigned(rotShown)));
  ditherText(CX, READOUT_Y, "TURN", C_ZINC400, textdatum_t::top_center, rotFader.alpha(), false);
  ditherText(CX, READOUT_Y + LINE_H, buf, C_WHITE, textdatum_t::top_center, rotFader.alpha(), false);
}

void drawReadout() {
  Orb* o = findOrb(selectedId.length() ? selectedId : lastReadoutId);
  if (!o || !readoutFader.visible()) return;
  char buf[64];
  if (normalMode) snprintf(buf, sizeof buf, "%04dK  B %03d", o->kelvin, o->bri);
  else snprintf(buf, sizeof buf, "H %03d  S %03d  B %03d", o->h, o->s, o->bri);
  String name = o->name; name.toUpperCase();
  if (name.length() > 18) name = name.substring(0, 18);
  float a = readoutFader.alpha();
  ditherText(CX, READOUT_Y, name.c_str(), dragging ? C_WHITE : C_ZINC400, textdatum_t::top_center, a, false);
  ditherText(CX, READOUT_Y + LINE_H, buf, dragging ? C_PURPLE : C_ZINC500, textdatum_t::top_center, a, false);
}

void drawRipples(uint32_t now) {
  for (auto it = ripples.begin(); it != ripples.end();) {
    float t = (now - it->start) / 450.f;
    if (t >= 1.f) { if (viewY == 0) { it = ripples.erase(it); } else { ++it; } continue; }
    float e = 1.f - (1.f - t) * (1.f - t);         // ease-out
    int rx = 4 + (int)(30 * e), ry = (int)(rx * SQUASH);
    canvas.drawEllipse(sx(it->wx), sy(it->wy, 0), rx, ry, blend(C_BG, it->color, 1.f - t));
    ++it;
  }
}

int orbHalf() { float e = floorFill * floorFill * (3.f - 2.f * floorFill); return (int)roundf(ORB_R * (0.7f + 0.3f * e)); }

void drawOrb(Orb& o, uint32_t now) {
  const bool sel = (o.id == selectedId);
  const bool drag = sel && dragging;
  const float bob = o.on ? sinf(now * 0.0016f + o.phase) * 1.5f : 0.f;
  // Anchor = the light's position on the wheel floor / kelvin bar. The
  // brightness offset (z) lifts the handle up on the wheel, but pushes it to
  // the RIGHT of the vertical bar in normal mode.
  const int AX = sx(o.x), Yf = sy(o.y, 0);
  const int X = normalMode ? AX + (int)roundf(o.z + bob) : AX;
  const int Y = normalMode ? Yf : sy(o.y, o.z + bob);
  const int r = orbHalf();

  // dropper ring at the anchor: hollow, with a white point at the centre
  canvas.drawEllipse(AX, Yf, (int)(normalMode ? 5 * SX : 9 * SX), (int)(5 * SX), blend(C_BG, C_WHITE, o.on ? 0.8f : 0.25f));
  canvas.fillRect(AX - 1, Yf - 1, 2, 2, o.on ? C_WHITE : blend(C_BG, C_WHITE, 0.4f));

  // projection line: 1 px dots, 1 on / 3 off, drifting slowly toward the handle
  const int off = (now / 120) % 4;
  if (normalMode) {
    if (o.on && X - r - 1 > AX + 2) {
      for (int x = AX + 2 + off; x < X - r - 1; x += 4) canvas.drawPixel(x, Yf, C_WHITE);
    }
  } else if (o.on && Y + r + 1 < Yf - 2) {
    for (int y = Yf - 2 - off; y > Y + r + 1; y -= 4) canvas.drawPixel(X, y, C_WHITE);
  }

  // the handle: a square
  if (o.on) {
    canvas.fillRect(X - r, Y - r, 2 * r + 1, 2 * r + 1, o.color);
    canvas.drawRect(X - r, Y - r, 2 * r + 1, 2 * r + 1, C_WHITE);             // white border
    canvas.drawRect(X - r - 1, Y - r - 1, 2 * r + 3, 2 * r + 3, 0x000000);   // black keyline outside it
  } else {
    canvas.fillRect(X - r, Y - r, 2 * r + 1, 2 * r + 1, C_ZINC800);
    canvas.drawRect(X - r, Y - r, 2 * r + 1, 2 * r + 1, blend(C_BG, C_WHITE, 0.45f));
  }

  // floating name when nothing is selected (painted later, on top of every handle)
  if (o.on && namesFader.visible()) {
    String n = o.name; n.toLowerCase();
    labels.push_back({X, Y - r - 5, n, blend(C_BG, C_WHITE, 0.85f), namesFader.alpha()});
  }

  // selection frame (pulsing) / long-press charge ring
  if (sel) {
    float pulse = 0.55f + 0.45f * sinf(now * 0.006f);
    int g = drag ? 7 : 5;
    canvas.drawRect(X - r - g, Y - r - g, 2 * (r + g) + 1, 2 * (r + g) + 1, blend(C_BG, C_WHITE, pulse));
  }
  if (hold == Hold::Orb && holdId == o.id && !dragging && !longFired && now - downMs > HOLD_GRACE_MS) {
    float p = fminf(1.f, (now - downMs - HOLD_GRACE_MS) / (float)HOLD_CHARGE_MS);
    // thick ring, radius chosen to poke out around a fingertip
    canvas.fillArc(X, Y, r + 14, r + 20, 0, 360, blend(C_BG, C_WHITE, 0.18f));
    canvas.fillArc(X, Y, r + 14, r + 20, -90, -90 + (int)(p * 360), C_WHITE);
  }
}

void drawStatus() {
  bool online = net::status() == net::Status::Online;
  ditherText(8, STATUS_Y, "LIVING ROOM", C_ZINC500, textdatum_t::bottom_left, roomFader.alpha(), false);
  if (offlineCount) {
    char buf[24]; snprintf(buf, sizeof buf, "%d OFFLINE", offlineCount);
    ditherText(CX, STATUS_Y, buf, C_ZINC700, textdatum_t::bottom_center, roomFader.alpha(), false);
  }
  canvas.fillCircle(W - 7, STATUS_Y - 4, 2, online ? C_GREEN : C_RED);
  String st = lastStatusText; st.toUpperCase();
  ditherText(W - 13, STATUS_Y, st.c_str(), C_ZINC500, textdatum_t::bottom_right, statusFader.alpha(), false);
  if (!online) canvas.drawRoundRect(0, 0, W, H, 4, C_RED);
}

// wisps: particles born on a dropper ring's edge that spiral up and fade
struct Wisp { bool alive = false; String id; float theta, radius, rise, life, seed; int frame = 0; };
constexpr int WISP_MAX = 120;
Wisp wisps[WISP_MAX];

// trail dots: each wisp drops one every few frames; they linger and fade
struct TrailDot { bool alive = false; int x, y; uint32_t color; float age; };
constexpr int TRAIL_MAX = 900;
constexpr float TRAIL_LIFE = 1.0f;
constexpr int TRAIL_EVERY = 3;          // frames between dots
TrailDot trail[TRAIL_MAX];
int trailNext = 0;
uint32_t lastWispMs = 0;

void spawnWisps(uint32_t now) {
  if (normalMode) return;   // z means "distance right" there; climbing wisps would read wrong
  // one wisp per frame (every other frame when pixel-doubled), from a random lit light's ring edge
  static uint32_t frameNo = 0;
  if (board::PIXEL_SCALE > 1 && (++frameNo & 1)) return;
  int lit = 0; for (auto& o : orbs) if (o.on) lit++;
  if (!lit) return;
  for (int k = 0; k < 1; k++) {
    int pick = rand() % lit;
    Orb* src = nullptr;
    for (auto& o : orbs) { if (!o.on) continue; if (pick-- == 0) { src = &o; break; } }
    if (!src) return;
    for (auto& w : wisps) {
      if (w.alive) continue;
      w.alive = true; w.id = src->id;
      w.theta = (rand() % 628) / 100.f;
      w.radius = 9.f * SX; w.rise = 0.f; w.life = 0.f; w.frame = rand() % TRAIL_EVERY;
      w.seed = (rand() % 100) / 100.f;
      break;
    }
  }
}

void drawWisps(float dt, bool advance) {
  const float converge = 0.30f * ZMAX;             // height by which a wisp has closed in on the line
  for (auto& w : wisps) {
    if (!w.alive) continue;
    Orb* o = findOrb(w.id);
    if (!o || !o->on) { w.alive = false; continue; }
    if (advance) {
      w.life += dt;
      // slow climb with a little surging; spin speed wanders
      w.rise  += dt * (11.f + 6.f * w.seed) * SY * (0.8f + 0.4f * sinf(w.life * 2.1f + w.seed * 9.f));
      w.theta += dt * (1.4f + 1.2f * w.seed) * (0.7f + 0.6f * sinf(w.life * 1.3f + w.seed * 5.f));
    }
    float k = fminf(1.f, w.rise / converge);
    k = k * k * (3.f - 2.f * k);                    // ease in-out: lingers wide, then closes (no cone)
    // never dead centre: a wandering orbit of 1.5..4 px around the line ...
    float wander = 2.7f + 1.3f * sinf(w.life * 1.7f + w.seed * 11.f);
    float excursion = (w.seed > 0.7f ? 4.f : 0.f) * sinf(w.life * 0.9f);   // some wisps roam wider
    // ... that braids into a near-unified strand over the top ~30 % of the climb
    float f = w.rise / fmaxf(o->z, 1.f);
    float tight = fmaxf(0.f, fminf(1.f, (f - 0.6f) / 0.25f)); tight = tight * tight * (3.f - 2.f * tight);
    wander *= 1.f - 0.92f * tight;                                           // ~0.3 px orbit at the top
    excursion *= 1.f - 0.85f * tight;                                        // a few still poke out
    w.radius = 9.f * SX * (1.f - k) + wander + fabsf(excursion) * (1.f - k * 0.5f);
    if (advance && w.rise > o->z + 2.f) { w.alive = false; continue; }   // reached the handle
    float a = fminf(1.f, w.life / 0.3f);            // quick fade-in, then full white
    int X = sx(o->x) + (int)roundf(w.radius * cosf(w.theta));
    int Y = sy(o->y, 0) + (int)roundf(w.radius * sinf(w.theta) * SQUASH) - (int)w.rise;
    canvas.drawPixel(X, Y, blend(C_BG, C_WHITE, a));    // the wisp itself is white
    if (advance && (++w.frame % TRAIL_EVERY) == 0) {      // ... and drops a dot in its light's colour
      TrailDot& d = trail[trailNext]; trailNext = (trailNext + 1) % TRAIL_MAX;
      d.alive = true; d.x = X; d.y = Y; d.color = o->color; d.age = 0.f;
    }
  }
}

void drawTrail(float dt, bool advance) {
  for (auto& d : trail) {
    if (!d.alive) continue;
    if (advance) { d.age += dt; if (d.age >= TRAIL_LIFE) { d.alive = false; continue; } }
    float a = 1.f - d.age / TRAIL_LIFE;
    canvas.drawPixel(d.x, d.y, blend(C_BG, d.color, a));
  }
}

// --- normal mode: the kelvin bar ---------------------------------------------
// A horizontal spectrum of blackbody radiator whites where the wheel's centre
// line is; CT-mode lights ride it like pins on the wheel.
void drawKelvinBar() {
  for (int y = KBV_Y0; y <= KBV_Y1; y++) {
    canvas.fillRect(KBV_X - KBV_HW, y, 2 * KBV_HW + 1, 1, kelvinToRgb888(yToKelvin((float)y)));
  }
  canvas.drawRoundRect(KBV_X - KBV_HW - 2, KBV_Y0 - 2, 2 * KBV_HW + 5, (KBV_Y1 - KBV_Y0) + 5, 3, blend(C_BG, C_WHITE, 0.3f));
  // ticks (2000 marks where real CT diodes end and emulation begins)
  const int ticks[5] = {1500, 2000, 2700, 4000, 5500};
  char buf[8];
  for (int k : ticks) {
    int y = (int)roundf(kelvinToY((float)k));
    canvas.fillRect(KBV_X + KBV_HW + 4, y, 3, 1, C_ZINC500);
    snprintf(buf, sizeof buf, "%dK", k);
    text(KBV_X + KBV_HW + 9, y, buf, C_ZINC500, textdatum_t::middle_left);
  }
}

// The global-shift track on the right: one handle at the midpoint (mean
// mired) of every pin on the bar; dragging it slides them all together.
struct GkGrab { String id; float m0; };
std::vector<GkGrab> gkOrbs;
float gkGrabDY = 0.f;       // finger-to-handle offset at grab
float gkStartMired = 0.f;   // handle (mean) mired at grab

float gkMeanMired() {
  if (orbs.empty()) return 1e6f / 2900.f;
  float m = 0;
  for (auto& o : orbs) m += 1e6f / fmaxf(1.f, o.kf);
  return m / orbs.size();
}

void drawGlobalK() {
  if (orbs.empty()) return;
  canvas.drawFastVLine(GK_X, KBV_Y0, KBV_Y1 - KBV_Y0, C_ZINC700);
  text(GK_X, KBV_Y0 - 6, "ALL", C_ZINC500, textdatum_t::bottom_center);
  const float m = gkMeanMired();
  const int y = (int)roundf(miredToY(m));
  const bool active = hold == Hold::GlobalK;
  const int h2 = (int)(5 * SX);
  canvas.fillRect(GK_X - h2, y - h2, 2 * h2 + 1, 2 * h2 + 1, kelvinToRgb888(1e6f / m));
  canvas.drawRect(GK_X - h2, y - h2, 2 * h2 + 1, 2 * h2 + 1, active ? C_WHITE : blend(C_BG, C_WHITE, 0.6f));
  // chevrons hinting the drag axis
  for (int i = 0; i < 3; i++) {
    canvas.drawPixel(GK_X - i, y - h2 - 3 - i, C_ZINC500); canvas.drawPixel(GK_X + i, y - h2 - 3 - i, C_ZINC500);
    canvas.drawPixel(GK_X - i, y + h2 + 3 + i, C_ZINC500); canvas.drawPixel(GK_X + i, y + h2 + 3 + i, C_ZINC500);
  }
  if (active) {
    char buf[8];
    snprintf(buf, sizeof buf, "%dK", (int)roundf(1e6f / m));
    text(GK_X - h2 - 5, y, buf, C_WHITE, textdatum_t::middle_right);
  }
}

// The circular mode button, above the online dot: shows the mode you're in —
// a mini hue ring in color mode, a warm-white disc in normal mode.
void drawModeButton() {
  if (normalMode) {
    canvas.fillCircle(MODE_CX, MODE_CY, MODE_R - 1, kelvinToRgb888(2900.f));
    canvas.fillCircle(MODE_CX - MODE_R / 4, MODE_CY - MODE_R / 4, MODE_R / 3, blend(kelvinToRgb888(2900.f), C_WHITE, 0.5f));
  } else {
    for (int i = 0; i < 12; i++)
      canvas.fillArc(MODE_CX, MODE_CY, MODE_R - 4, MODE_R - 1, i * 30.f, i * 30.f + 31.f, hsvToRgb888(i * 30.f, 100.f, 92.f));
  }
  canvas.drawEllipse(MODE_CX, MODE_CY, MODE_R + 1, MODE_R + 1, C_ZINC500);
}

void toggleMode(uint32_t now) {
  normalMode = !normalMode;
  selectedId = "";
  for (auto& w : wisps) w.alive = false;   // their geometry doesn't survive the mode change
  net::setMode(normalMode);
  syncOrbs();                       // re-filter + retarget orbs for the new mode
  floorSig = 0;                     // wheel cache is stale after a mode round-trip
  lastInteractMs = now;
}

float wispDt = 0.f;
// Blank the whole band (normal mode paints no disc, so everything clears).
void clearFrameFull() {
  memset(frame.getBuffer(), 0, (size_t)W * BAND_H * 2);
}
void clearFrame() {
  uint16_t* dst = (uint16_t*)frame.getBuffer();
  const float R2in = (R - 1.5f) * (R - 1.5f);
  for (int y = viewY; y < viewY + BAND_H; y++) {
    uint16_t* row = dst + (y - viewY) * W;
    float v = (y + 0.5f - CY) / SQUASH;
    float rem = R2in - v * v;
    if (y < CY - RY || y >= CY + RY || rem <= 0) { memset(row, 0, W * 2); continue; }
    int hw = (int)sqrtf(rem);
    int xl = max(CX - RX, CX - hw), xr = min(CX + RX - 1, CX + hw);
    memset(row, 0, xl * 2);                               // left of the disc
    memset(row + xr + 1, 0, (W - xr - 1) * 2);            // right of the disc
  }
}

void render(uint32_t now) {
  uint32_t t0 = micros();
  if (!normalMode) updateFloorCache();                    // once per frame
  renderAccumUs += micros() - t0; renderFrames++;

  for (int band = 0; band < BANDS; band++) {
    viewY = band * BAND_H;
    if (normalMode) { clearFrameFull(); drawKelvinBar(); drawGlobalK(); }
    else            { clearFrame(); pushFloorCache(); }   // the floor cache fills the disc itself
    drawRipples(now);
    drawTrail(wispDt, band == 0);
    drawWisps(wispDt, band == 0);

    // painter's order: far (top of screen) first; dragged/selected orb last
    std::vector<Orb*> order;
    for (auto& o : orbs) order.push_back(&o);
    std::sort(order.begin(), order.end(), [](Orb* a, Orb* b) { return a->y < b->y; });
    labels.clear();
    for (Orb* o : order) if (o->id != selectedId) drawOrb(*o, now);
    if (Orb* o = findOrb(selectedId)) drawOrb(*o, now);
    for (auto& L : labels) {
      scratch.setFont(UI_FONT);
      scratch.setTextSize(TS);
      int half = scratch.textWidth(L.text.c_str()) / 2 + 3;
      int x = constrain(L.x, half, W - half);            // push in from the edges
      ditherText(x, L.y, L.text.c_str(), L.color, textdatum_t::bottom_center, L.alpha, true);
    }

    drawBar(now);
    drawReadout();
    drawRotReadout();
    drawStatus();
    drawModeButton();
    if (board::PIXEL_SCALE == 1) frame.pushSprite(0, viewY);
    else { frame.setPivot(0, 0); frame.pushRotateZoom(&lcd, 0, viewY * board::PIXEL_SCALE, 0.f, board::PIXEL_SCALE, board::PIXEL_SCALE); }
  }
  viewY = 0;
}

void animate(float dt) {
  namesFader.update(selectedId.length() == 0, dt);
  readoutFader.update(selectedId.length() != 0, dt);
  if (selectedId.length()) lastReadoutId = selectedId;
  roomFader.update(true, dt);
  // status text: dissolve out the old string, then in the new one
  String st = net::statusText();
  if (st != lastStatusText) { if (!statusFader.visible()) lastStatusText = st; statusFader.update(false, dt); }
  else statusFader.update(true, dt);
  // wheel rotation state machine
  uint32_t now = millis();
  switch (rotPhase) {
    case RotPhase::Settling:
      if (now - rotPhaseMs >= ROT_SETTLE_MS) { rotPhase = RotPhase::Returning; rotPhaseMs = now; rotReturnFrom = normDegSigned(wheelRot); }
      break;
    case RotPhase::Returning: {
      float tt = (now - rotPhaseMs) / (float)ROT_RETURN_MS;
      wheelRot = rotReturnFrom * (1.f - easeInOut(tt));
      if (tt >= 1.f) { wheelRot = 0.f; rotPhase = RotPhase::Idle; }
      break;
    }
    default: break;
  }
  spawnWisps(now); wispDt = dt;
  const bool wheelMoving = rotPhase != RotPhase::Idle;
  const bool awake = hold != Hold::None || wheelMoving || (now - lastInteractMs < FLOOR_AWAKE_MS);
  floorFill += ((awake ? 1.f : 0.f) - floorFill) * fminf(1.f, dt * (awake ? 7.f : 3.f));
  rotFader.update(rotPhase == RotPhase::Dragging || rotPhase == RotPhase::Settling, dt);
  if (rotPhase == RotPhase::Dragging || rotPhase == RotPhase::Settling) rotShown = wheelRot;

  for (auto& o : orbs) {
    orbWorld(o, o.tx, o.ty);                       // targets follow the wheel angle
    bool held = (hold == Hold::Orb && holdId == o.id && dragging);
    if (wheelMoving) { o.x = o.tx; o.y = o.ty; }   // pinned to the disc while it turns
    else if (!held) { o.x += (o.tx - o.x) * 0.18f; o.y += (o.ty - o.y) * 0.18f; }
    o.z += (o.tz - o.z) * 0.12f;
  }
}

// --- input -------------------------------------------------------------------
Orb* orbAt(int x, int y, uint32_t now) {
  Orb* best = nullptr; int bestD = HIT_R * HIT_R;
  for (auto& o : orbs) {
    float bob = o.on ? sinf(now * 0.0016f + o.phase) * 1.5f : 0.f;
    int ox = normalMode ? sx(o.x) + (int)roundf(o.z + bob) : sx(o.x);
    int oy = normalMode ? sy(o.y, 0) : sy(o.y, o.z + bob);
    int d = (ox - x) * (ox - x) + (oy - y) * (oy - y);
    if (o.id == selectedId) d -= 24;
    if (d < bestD) { bestD = d; best = &o; }
  }
  return best;
}

void applyBar(int x) {
  int v = constrain((x - BAR_X) * 100 / BAR_W, 1, 100);
  if (barSingle) {
    Orb* o = findOrb(selectedId);
    if (!o) return;
    o->bri = v;
    o->tz = o->on ? v / 100.f * (normalMode ? KB_RANGE : ZMAX) : 0;
    if (o->id == "curtains") { curtainsBri = v; net::setCurtainsVal((int)roundf(v * 2.55f)); }
    else net::setBrightness(o->id, v);
    return;
  }
  for (auto& r : barRatios) net::setBrightness(r.id, max(1, (int)roundf(v * r.ratio)));
}

// Move one pin to a kelvin value: updates the orb and sends (shared by the
// single-pin drag and the global-shift drag).
void setOrbKelvin(Orb& o, float kf) {
  o.kf = kf;
  orbWorld(o, o.x, o.y);
  o.tx = o.x; o.ty = o.y;
  int k = (int)roundf(kf / 10.f) * 10;                // 10K send granularity
  if (k == o.kelvin) return;
  o.kelvin = k;
  o.color = kelvinToRgb888(kf);
  if (o.id == "curtains") { curtainsKf = kf; net::setCurtainsKelvin(k); }
  else net::setTemperature(o.id, k);
}

void onDown(int x, int y, uint32_t now) {
  downX = x; downY = y; downMs = now; dragging = false; longFired = false; lastInteractMs = now;
  {
    int dx = x - MODE_CX, dy = y - MODE_CY, rr = MODE_R + 8;
    if (dx * dx + dy * dy <= rr * rr) { toggleMode(now); return; }
  }
  if (y <= BAR_Y + BAR_DROP + BAR_H + 16 && x >= BAR_X - 12 && x <= BAR_X + BAR_W + 12) {
    hold = Hold::Bar;
    // selected light -> its own slider (the curtains pin included: its slider
    // drives the twinkle brightness); global is paused
    barSingle = selectedId.length() > 0 && findOrb(selectedId) != nullptr;
    lastInteractMs = now;
    barRatios.clear();
    int m = maxBrightness();
    for (auto& l : lights) if (l.on && l.reachable) barRatios.push_back({l.id, m > 0 ? (float)l.brightness / m : 1.f});
    applyBar(x);
    return;
  }
  // The global-shift handle (normal mode, right edge): grab and slide every
  // pin along the locus at once.
  if (normalMode && abs(x - GK_X) <= (int)(16 * SX) && y >= KBV_Y0 - 12 && y <= KBV_Y1 + 12 && !orbs.empty()) {
    hold = Hold::GlobalK;
    gkStartMired = gkMeanMired();
    gkGrabDY = miredToY(gkStartMired) - y;
    gkOrbs.clear();
    for (auto& o : orbs) {
      gkOrbs.push_back({o.id, 1e6f / fmaxf(1.f, o.kf)});
      if (o.id != "curtains") net::startControlling(o.id);
    }
    return;
  }
  if (Orb* o = orbAt(x, y, now)) {
    hold = Hold::Orb; holdId = o->id; selectedId = o->id;
    // Finger-to-handle offset. The brightness offset (z) lifts the handle up
    // on the wheel but pushes it RIGHT of the vertical bar in normal mode —
    // capture the offset against where the handle actually is.
    if (normalMode) { grabDX = (sx(o->x) + (int)roundf(o->z)) - x; grabDY = sy(o->y, 0) - y; }
    else { grabDX = sx(o->x) - x; grabDY = sy(o->y, o->z) - y; }
    return;
  }
  if (!normalMode) {
    // grab the dial: lower part of the rim band
    float wx = x - CX, wy = (y - CY) / SQUASH;
    float d = sqrtf(wx * wx + wy * wy) / R;
    if (d >= RIM_IN && d <= RIM_OUT && wy > 0.25f * R) {
      hold = Hold::Rim;
      rotGrabAngle = atan2f(wy, wx) * 180.f / (float)M_PI;
      rimTouchAngle = rotGrabAngle + 90.f;
      rotAtGrab = wheelRot;
      rotPhase = RotPhase::Dragging;
      rotOrbs.clear();
      for (auto& o : orbs) {
        if (!o.on) continue;
        rotOrbs.push_back({o.id, normDeg(o.hf + wheelRot)});  // screen angle it must keep
        net::startControlling(o.id);
      }
      return;
    }
  }
  hold = Hold::Floor;
  float wx = x - CX, wy = (y - CY) / SQUASH;
  if (normalMode) {
    if (abs(x - KBV_X) <= KBV_HW * 3 && y >= KBV_Y0 - 8 && y <= KBV_Y1 + 8)
      ripples.push_back({wx, (y - CY) / SQUASH, now, kelvinToRgb888(yToKelvin((float)y))});
  } else if (wx * wx + wy * wy <= (float)R * R * 1.1f) {
    int h, s; worldToHs(wx, wy, h, s);
    ripples.push_back({wx, wy, now, hsvToRgb888(h, s, 100)});
  }
}

void onMove(int x, int y, uint32_t now) {
  lastInteractMs = now;
  if (hold == Hold::Orb) {
    Orb* o = findOrb(holdId);
    if (!o) return;
    if (!dragging && (abs(x - downX) > 6 || abs(y - downY) > 6) && !longFired) {
      dragging = true;
      net::startControlling(o->id);
    }
    if (!dragging) return;
    if (normalMode) {
      // slide along the vertical bar: only y matters
      setOrbKelvin(*o, yToKelvin((float)(y + grabDY)));
      return;
    }
    // finger + grab offset -> floor coords at the orb's (locked) height
    float wx = (x + grabDX) - CX;
    float wy = ((y + grabDY) - CY + o->z) / SQUASH;
    float hf, sf; worldToHsF(wx, wy, hf, sf);
    o->hf = hf; o->sf = sf;
    hsToWorldF(hf, sf, o->x, o->y);        // clamps to the rim, no integer steps
    o->tx = o->x; o->ty = o->y;
    int h = (int)roundf(hf) % 360, s = (int)roundf(sf);
    if (h != o->h || s != o->s) { o->h = h; o->s = s; o->color = hsvToRgb888(hf, sf, 100); net::setColor(o->id, h, s); }
  } else if (hold == Hold::Bar) {
    applyBar(x);
  } else if (hold == Hold::GlobalK) {
    float dm = yToMired((float)(y + gkGrabDY)) - gkStartMired;
    for (auto& g : gkOrbs) {
      Orb* o = findOrb(g.id);
      if (!o) continue;
      float m = fmaxf(MIRED_COOL, fminf(MIRED_WARM, g.m0 + dm));
      setOrbKelvin(*o, 1e6f / m);
    }
  } else if (hold == Hold::Rim) {
    float wx = x - CX, wy = (y - CY) / SQUASH;
    float a = atan2f(wy, wx) * 180.f / (float)M_PI;
    rimTouchAngle = a + 90.f;
    wheelRot = normDeg(rotAtGrab + (a - rotGrabAngle));
    // orbs stay where they are; the colour under them changes
    for (auto& ro : rotOrbs) {
      Orb* o = findOrb(ro.id);
      if (!o) continue;
      o->hf = normDeg(ro.angle0 - wheelRot);
      int h = (int)roundf(o->hf) % 360;
      if (h != o->h) { o->h = h; o->color = hsvToRgb888(o->hf, o->sf, 100); net::setColor(o->id, h, o->s); }
    }
  }
}

void onUp(int x, int y, uint32_t now) {
  lastInteractMs = now;
  if (hold == Hold::Orb) {
    if (dragging) net::stopControlling(holdId);
  } else if (hold == Hold::Floor) {
    selectedId = "";                       // tap the floor to deselect
  } else if (hold == Hold::GlobalK) {
    for (auto& g : gkOrbs) if (g.id != "curtains") net::stopControlling(g.id);
    gkOrbs.clear();
  } else if (hold == Hold::Rim) {
    for (auto& ro : rotOrbs) net::stopControlling(ro.id);
    rotOrbs.clear();
    rotPhase = RotPhase::Settling; rotPhaseMs = now;
  }
  hold = Hold::None; holdId = ""; dragging = false; longFired = false;
}

void checkLongPress(uint32_t now) {
  if (hold != Hold::Orb || dragging || longFired) return;
  if (now - downMs < HOLD_GRACE_MS + HOLD_CHARGE_MS) return;
  Orb* o = findOrb(holdId);
  if (!o) return;
  longFired = true;
  if (o->id == "curtains") return;   // no on/off for the routine pin
  net::setOn(o->id, !o->on);
  ripples.push_back({o->x, o->y, now, o->on ? C_ZINC500 : o->color});
}

}  // namespace

void begin() {
  lcd.init();
  lcd.setBrightness(220);
  lcd.fillScreen(C_BG);
  lcd.setFont(&fonts::Font2);
  lcd.setTextDatum(textdatum_t::middle_center);
  lcd.setTextColor(C_ZINC400, C_BG);
  lcd.drawString("screenbox", lcd.width() / 2, lcd.height() / 2);

  frame.setColorDepth(16);
  frame.setPsram(false);                       // internal RAM if it fits (fast), else PSRAM
  if (!frame.createSprite(W, BAND_H)) {
    frame.setPsram(true);
    if (!frame.createSprite(W, BAND_H)) {
      Serial.println("[ui] frame sprite alloc FAILED (no PSRAM?) — halting");
      lcd.setTextColor(C_RED, C_BG);
      lcd.drawString("no PSRAM - check board env", W / 2, H / 2 + 20);
      for (;;) delay(1000);
    }
    Serial.println("[ui] frame band in PSRAM");
  } else Serial.printf("[ui] frame band in internal RAM (%d band%s of %d rows)\n", BANDS, BANDS > 1 ? "s" : "", BAND_H);
  buildFloor();
  scratch.setColorDepth(16);
  scratch.createSprite(SCRATCH_W, SCRATCH_H);
  Serial.printf("[ui] sprites ready, free heap=%u psram=%u\n", ESP.getFreeHeap(), ESP.getFreePsram());
}

void loop() {
  uint32_t now = millis();
  uint16_t tx, ty;
  bool touched = lcd.getTouch(&tx, &ty);
  tx /= board::PIXEL_SCALE; ty /= board::PIXEL_SCALE;   // logical pixels
  if (touched && !wasTouched)      onDown(tx, ty, now);
  else if (touched && wasTouched)  onMove(tx, ty, now);
  else if (!touched && wasTouched) onUp(tx, ty, now);
  wasTouched = touched;
  checkLongPress(now);
  if (selectedId.length() && hold == Hold::None && now - lastInteractMs > SELECT_TIMEOUT_MS) selectedId = "";

  uint32_t v = net::version();
  if (v != seenVersion) { seenVersion = v; syncOrbs(); lastRemoteMs = now; }

  // Thermal idle: nobody touching, nothing changing remotely -> dim the
  // backlight, drop to ~6fps, downclock 240 -> 80MHz. Wakes on the same
  // touch that does the thing (the dim is mild enough to read through).
  bool awake = touched || now - lastInteractMs < IDLE_AFTER_MS || now - lastRemoteMs < REMOTE_WAKE_MS;
  if (awake == idleCool) {
    idleCool = !awake;
    setCpuFrequencyMhz(idleCool ? 80 : 240);
    lcd.setBrightness(idleCool ? 60 : 220);
    Serial.printf("[ui] %s\n", idleCool ? "idle: dim + 80MHz" : "awake: bright + 240MHz");
  }

  if (now - lastFrameMs >= (idleCool ? 167u : 33u)) {
    animate((now - lastFrameMs) / 1000.f);
    render(now);
    lastFrameMs = now;
  }
  static uint32_t lastPerf = 0;
  if (now - lastPerf > 10000 && renderFrames) {
    Serial.printf("[ui] floor composite avg %lu us over %lu frames\n", (unsigned long)(renderAccumUs / renderFrames), (unsigned long)renderFrames);
    renderAccumUs = 0; renderFrames = 0; lastPerf = now;
  }
  delay(idleCool ? 8 : 1);
}

}  // namespace ui
