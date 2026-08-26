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

namespace ui {
namespace {

board::Display lcd;
LGFX_Sprite    frame(&lcd);      // full-screen back buffer (PSRAM)
LGFX_Sprite    floorSpr(&lcd);   // pre-rendered, pre-squashed wheel (PSRAM)

constexpr int W = board::LCD_W, H = board::LCD_H;

// --- scene / projection ------------------------------------------------------
// World: x right, y "into the screen" (toward the top), z up. Orthographic
// camera pitched so the floor squashes vertically by SQUASH.
constexpr int   R      = 104;                 // wheel radius, world units == px
constexpr float SQUASH = 0.72f;
constexpr int   RX = R, RY = (int)(R * SQUASH + 0.5f);
constexpr int   CX = W / 2, CY = 218;         // floor centre on screen
constexpr int   ZMAX = 78;                    // orb height at brightness 100
constexpr int   ORB_R = 10, HIT_R = 24;
constexpr int   GLOW_PX = 8;                  // halo drawn outside the floor rim

constexpr int BAR_X = 22, BAR_Y = 14, BAR_W = 170, BAR_H = 6;
constexpr int READOUT_Y = 34;
constexpr int STATUS_Y = H - 5;
constexpr uint32_t HOLD_GRACE_MS  = 500;    // hold this long before the ring starts
constexpr uint32_t HOLD_CHARGE_MS = 500;    // ring fill time -> toggle
constexpr uint32_t SELECT_TIMEOUT_MS = 5000;

// --- palette -----------------------------------------------------------------
constexpr uint32_t C_BG      = 0x09090b;
constexpr uint32_t C_ZINC800 = 0x27272a;
constexpr uint32_t C_ZINC700 = 0x3f3f46;
constexpr uint32_t C_ZINC500 = 0x71717a;
constexpr uint32_t C_ZINC400 = 0xa1a1aa;
constexpr uint32_t C_ZINC50  = 0xfafafa;
constexpr uint32_t C_PURPLE  = 0xa855f7;
constexpr uint32_t C_WHITE   = 0xffffff;
constexpr uint32_t C_GREEN   = 0x22c55e;
constexpr uint32_t C_RED     = 0xf87171;

// --- state -------------------------------------------------------------------
struct Orb {
  String id, name;
  int h = 0, s = 0, bri = 0;
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
enum class Hold { None, Orb, Bar, Floor };
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

struct Ripple { float wx, wy; uint32_t start; uint32_t color; };
std::vector<Ripple> ripples;

// --- dithered fades ----------------------------------------------------------
// Text doesn't pop in and out: it dissolves through a 4x4 Bayer pattern.
LGFX_Sprite scratch(&lcd);          // small internal-RAM sprite for glyph masks
constexpr int SCRATCH_W = 220, SCRATCH_H = 14;
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
  scratch.setFont(&fonts::Font0);
  int w = scratch.textWidth(s) + 2, h = 10;
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
        if (shadow) frame.drawPixel(sx + 1, sy + 1, 0x000000);
        frame.drawPixel(sx, sy, color);
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
void hsToWorld(int h, int s, float& wx, float& wy) {
  float a = (h - 90) * (float)M_PI / 180.f, d = s / 100.f * R;
  wx = d * cosf(a); wy = d * sinf(a);
}
void worldToHs(float wx, float wy, int& h, int& s) {
  float dist = sqrtf(wx * wx + wy * wy);
  float ang = atan2f(wy, wx) * 180.f / (float)M_PI + 90.f;
  h = (int)roundf(fmodf(fmodf(ang, 360.f) + 360.f, 360.f)) % 360;
  s = (int)roundf(fminf(100.f, dist / R * 100.f));
}
inline int   sx(float wx)           { return CX + (int)roundf(wx); }
inline int   sy(float wy, float z)  { return CY + (int)roundf(wy * SQUASH - z); }

Orb* findOrb(const String& id) { for (auto& o : orbs) if (o.id == id) return &o; return nullptr; }
int maxBrightness() { int m = 0; for (auto& l : lights) if (l.on && l.reachable) m = max(m, l.brightness); return m; }

// --- sync from net -----------------------------------------------------------
void syncOrbs() {
  lights = net::lights();
  offlineCount = 0;
  std::vector<Orb> next;
  for (auto& l : lights) {
    if (!l.reachable) { offlineCount++; continue; }
    if (!l.canColor) continue;
    Orb o;
    if (Orb* prev = findOrb(l.id)) o = *prev;
    else { o.id = l.id; o.phase = (float)(rand() % 628) / 100.f; o.fresh = true; }
    o.name = l.name; o.h = l.h; o.s = l.s; o.bri = l.brightness; o.on = l.on;
    o.color = hsvToRgb888(l.h, l.s, 100);
    hsToWorld(l.h, l.s, o.tx, o.ty);
    o.tz = l.on ? l.brightness / 100.f * ZMAX : 0;
    if (o.fresh) { o.x = o.tx; o.y = o.ty; o.z = -ORB_R * 2; o.fresh = false; }   // new orbs rise up from below
    next.push_back(o);
  }
  orbs = next;
}

// --- floor -------------------------------------------------------------------
void buildFloor() {
  const int Wf = (RX + GLOW_PX) * 2, Hf = (RY + GLOW_PX) * 2;
  floorSpr.setColorDepth(16);
  floorSpr.setPsram(true);
  floorSpr.createSprite(Wf, Hf);
  const float cx = Wf / 2.f, cy = Hf / 2.f;
  for (int y = 0; y < Hf; y++) {
    for (int x = 0; x < Wf; x++) {
      float u = (x + 0.5f - cx) / RX, v = (y + 0.5f - cy) / RY;   // unit-disc coords
      float dist = sqrtf(u * u + v * v);
      uint32_t c = C_BG;
      if (dist <= 1.f) {
        float ang = atan2f(v, u) * 180.f / (float)M_PI + 90.f;
        if (ang < 0) ang += 360.f;
        c = hsvToRgb888(ang, dist * 100.f, 88.f);        // slightly under V=100 so orbs pop
        // etched grid: saturation rings at 25/50/75 %, hue spokes every 30°
        float ringD = fabsf(dist * 4.f - roundf(dist * 4.f));
        if (dist > 0.05f && dist < 0.98f && ringD < 0.03f) c = blend(c, C_WHITE, 0.28f);
        float spokeD = fabsf(ang / 30.f - roundf(ang / 30.f));
        if (dist > 0.12f && spokeD < 0.012f) c = blend(c, C_WHITE, 0.20f);
        // centre bloom (web cosmetic) + anti-aliased rim
        if (dist < 0.12f) c = blend(c, C_WHITE, 0.7f * (1.f - dist / 0.12f));
        float rimPx = (1.f - dist) * RX;
        if (rimPx < 1.f) c = blend(C_BG, c, rimPx);
      } else {
        // soft purple halo outside the rim
        float outPx = (dist - 1.f) * RX;
        if (outPx < GLOW_PX) c = blend(C_BG, C_PURPLE, 0.30f * (1.f - outPx / GLOW_PX) * (1.f - outPx / GLOW_PX));
      }
      floorSpr.drawPixel(x, y, c);
    }
  }
}

// --- drawing -----------------------------------------------------------------
void text(int x, int y, const char* s, uint32_t c, textdatum_t d = textdatum_t::top_left) {
  frame.setFont(&fonts::Font0);
  frame.setTextDatum(d);
  frame.setTextColor(c);
  frame.drawString(s, x, y);
}
void shadowText(int x, int y, const char* s, uint32_t c, textdatum_t d) {
  text(x + 1, y + 1, s, 0x000000, d);
  text(x, y, s, c, d);
}

void drawBar(uint32_t now) {
  int m = maxBrightness();
  int fillW = BAR_W * m / 100;
  frame.fillRoundRect(BAR_X, BAR_Y, BAR_W, BAR_H, BAR_H / 2, C_ZINC800);
  for (int i = 1; i < 10; i++) frame.drawFastVLine(BAR_X + BAR_W * i / 10, BAR_Y + BAR_H + 2, 2, C_ZINC700);
  if (fillW > 0) frame.fillRoundRect(BAR_X, BAR_Y, max(fillW, BAR_H), BAR_H, BAR_H / 2, blend(C_ZINC50, C_PURPLE, 0.25f));
  int tx = BAR_X + fillW;
  bool active = hold == Hold::Bar;
  frame.fillRoundRect(tx - 2, BAR_Y - 4, 4, BAR_H + 8, 2, active ? C_PURPLE : C_WHITE);
  char buf[8]; snprintf(buf, sizeof buf, "%3d", m);
  text(BAR_X + BAR_W + 8, BAR_Y + BAR_H / 2, buf, active ? C_WHITE : C_ZINC400, textdatum_t::middle_left);
  text(BAR_X + BAR_W + 26, BAR_Y + BAR_H / 2, "%", C_ZINC500, textdatum_t::middle_left);
  text(BAR_X, BAR_Y - 2, "LEVEL", C_ZINC500, textdatum_t::bottom_left);   // 8px glyphs -> top at y=4
}

String lastReadoutId;   // keep showing the last orb while it fades out
void drawReadout() {
  Orb* o = findOrb(selectedId.length() ? selectedId : lastReadoutId);
  if (!o || !readoutFader.visible()) return;
  char buf[64];
  snprintf(buf, sizeof buf, "H %03d  S %03d  B %03d", o->h, o->s, o->bri);
  String name = o->name; name.toUpperCase();
  if (name.length() > 18) name = name.substring(0, 18);
  float a = readoutFader.alpha();
  ditherText(CX, READOUT_Y, name.c_str(), dragging ? C_WHITE : C_ZINC400, textdatum_t::top_center, a, false);
  ditherText(CX, READOUT_Y + 11, buf, dragging ? C_PURPLE : C_ZINC500, textdatum_t::top_center, a, false);
}

void drawRipples(uint32_t now) {
  for (auto it = ripples.begin(); it != ripples.end();) {
    float t = (now - it->start) / 450.f;
    if (t >= 1.f) { it = ripples.erase(it); continue; }
    float e = 1.f - (1.f - t) * (1.f - t);         // ease-out
    int rx = 4 + (int)(30 * e), ry = (int)(rx * SQUASH);
    frame.drawEllipse(sx(it->wx), sy(it->wy, 0), rx, ry, blend(C_BG, it->color, 1.f - t));
    ++it;
  }
}

void drawOrb(Orb& o, uint32_t now) {
  const bool sel = (o.id == selectedId);
  const bool drag = sel && dragging;
  const float bob = o.on ? sinf(now * 0.0016f + o.phase) * 1.5f : 0.f;
  const int X = sx(o.x), Yf = sy(o.y, 0), Y = sy(o.y, o.z + bob);

  // landing marker on the floor
  frame.fillEllipse(X, Yf, 5, 3, blend(C_BG, C_WHITE, o.on ? 0.85f : 0.3f));
  frame.drawEllipse(X, Yf, 9, 5, blend(C_BG, C_WHITE, o.on ? 0.45f : 0.15f));

  // marching dotted projection line
  if (o.on && Y + ORB_R + 3 < Yf - 3) {
    const int period = drag ? 5 : 7;
    const int off = (now / (drag ? 28 : 55)) % period;
    uint32_t dot = blend(C_BG, C_WHITE, 0.75f);
    for (int y = Y + ORB_R + 3 + off; y < Yf - 3; y += period) frame.fillRect(X, y, 2, 2, dot);
  }

  // the orb
  if (o.on) {
    frame.fillCircle(X, Y, ORB_R + 4, blend(C_BG, o.color, 0.18f));   // faint halo
    frame.fillCircle(X, Y, ORB_R, o.color);
    frame.drawCircle(X, Y, ORB_R, C_WHITE);
    frame.drawCircle(X, Y, ORB_R + 1, blend(C_BG, C_WHITE, 0.5f));
  } else {
    frame.fillCircle(X, Y, ORB_R, C_ZINC800);
    frame.drawCircle(X, Y, ORB_R, blend(C_BG, C_WHITE, 0.45f));
  }

  // floating name when nothing is selected (dissolves in/out)
  if (o.on && namesFader.visible()) {
    String n = o.name; n.toLowerCase();
    ditherText(X, Y - ORB_R - 5, n.c_str(), blend(C_BG, C_WHITE, 0.85f), textdatum_t::bottom_center, namesFader.alpha(), true);
  }

  // selection ring (pulsing) / long-press charge ring
  if (sel) {
    float pulse = 0.55f + 0.45f * sinf(now * 0.006f);
    frame.drawCircle(X, Y, ORB_R + (drag ? 7 : 5), blend(C_BG, C_WHITE, pulse));
  }
  if (hold == Hold::Orb && holdId == o.id && !dragging && !longFired && now - downMs > HOLD_GRACE_MS) {
    float p = fminf(1.f, (now - downMs - HOLD_GRACE_MS) / (float)HOLD_CHARGE_MS);
    // thick ring, radius chosen to poke out around a fingertip
    frame.fillArc(X, Y, ORB_R + 14, ORB_R + 20, 0, 360, blend(C_BG, C_WHITE, 0.18f));
    frame.fillArc(X, Y, ORB_R + 14, ORB_R + 20, -90, -90 + (int)(p * 360), C_WHITE);
  }
}

void drawStatus() {
  bool online = net::status() == net::Status::Online;
  ditherText(8, STATUS_Y, "LIVING ROOM", C_ZINC500, textdatum_t::bottom_left, roomFader.alpha(), false);
  if (offlineCount) {
    char buf[24]; snprintf(buf, sizeof buf, "%d OFFLINE", offlineCount);
    ditherText(CX, STATUS_Y, buf, C_ZINC700, textdatum_t::bottom_center, roomFader.alpha(), false);
  }
  frame.fillCircle(W - 7, STATUS_Y - 4, 2, online ? C_GREEN : C_RED);
  String st = lastStatusText; st.toUpperCase();
  ditherText(W - 13, STATUS_Y, st.c_str(), C_ZINC500, textdatum_t::bottom_right, statusFader.alpha(), false);
  if (!online) frame.drawRoundRect(0, 0, W, H, 4, C_RED);
}

void render(uint32_t now) {
  frame.fillScreen(C_BG);
  floorSpr.pushSprite(&frame, CX - RX - GLOW_PX, CY - RY - GLOW_PX);
  drawRipples(now);

  // painter's order: far (top of screen) first; dragged/selected orb last
  std::vector<Orb*> order;
  for (auto& o : orbs) order.push_back(&o);
  std::sort(order.begin(), order.end(), [](Orb* a, Orb* b) { return a->y < b->y; });
  for (Orb* o : order) if (o->id != selectedId) drawOrb(*o, now);
  if (Orb* o = findOrb(selectedId)) drawOrb(*o, now);

  drawBar(now);
  drawReadout();
  drawStatus();
  frame.pushSprite(0, 0);
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
  for (auto& o : orbs) {
    bool held = (hold == Hold::Orb && holdId == o.id && dragging);
    if (!held) { o.x += (o.tx - o.x) * 0.18f; o.y += (o.ty - o.y) * 0.18f; }
    o.z += (o.tz - o.z) * 0.12f;
  }
}

// --- input -------------------------------------------------------------------
Orb* orbAt(int x, int y, uint32_t now) {
  Orb* best = nullptr; int bestD = HIT_R * HIT_R;
  for (auto& o : orbs) {
    float bob = o.on ? sinf(now * 0.0016f + o.phase) * 1.5f : 0.f;
    int ox = sx(o.x), oy = sy(o.y, o.z + bob);
    int d = (ox - x) * (ox - x) + (oy - y) * (oy - y);
    if (o.id == selectedId) d -= 24;
    if (d < bestD) { bestD = d; best = &o; }
  }
  return best;
}

void applyBar(int x) {
  int newMax = constrain((x - BAR_X) * 100 / BAR_W, 1, 100);
  for (auto& r : barRatios) net::setBrightness(r.id, max(1, (int)roundf(newMax * r.ratio)));
}

void onDown(int x, int y, uint32_t now) {
  downX = x; downY = y; downMs = now; dragging = false; longFired = false; lastInteractMs = now;
  if (Orb* o = orbAt(x, y, now)) {
    hold = Hold::Orb; holdId = o->id; selectedId = o->id;
    grabDX = sx(o->x) - x; grabDY = sy(o->y, o->z) - y;
    return;
  }
  if (y <= BAR_Y + BAR_H + 16 && x >= BAR_X - 12 && x <= BAR_X + BAR_W + 12) {
    hold = Hold::Bar;
    barRatios.clear();
    int m = maxBrightness();
    for (auto& l : lights) if (l.on && l.reachable) barRatios.push_back({l.id, m > 0 ? (float)l.brightness / m : 1.f});
    applyBar(x);
    return;
  }
  hold = Hold::Floor;
  float wx = x - CX, wy = (y - CY) / SQUASH;
  if (wx * wx + wy * wy <= (float)R * R * 1.1f) {
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
    // finger + grab offset -> floor coords at the orb's (locked) height
    float wx = (x + grabDX) - CX;
    float wy = ((y + grabDY) - CY + o->z) / SQUASH;
    int h, s; worldToHs(wx, wy, h, s);
    hsToWorld(h, s, o->x, o->y);           // clamps to the rim
    o->tx = o->x; o->ty = o->y; o->h = h; o->s = s; o->color = hsvToRgb888(h, s, 100);
    net::setColor(o->id, h, s);
  } else if (hold == Hold::Bar) {
    applyBar(x);
  }
}

void onUp(int x, int y, uint32_t now) {
  lastInteractMs = now;
  if (hold == Hold::Orb) {
    if (dragging) net::stopControlling(holdId);
  } else if (hold == Hold::Floor) {
    selectedId = "";                       // tap the floor to deselect
  }
  hold = Hold::None; holdId = ""; dragging = false; longFired = false;
}

void checkLongPress(uint32_t now) {
  if (hold != Hold::Orb || dragging || longFired) return;
  if (now - downMs < HOLD_GRACE_MS + HOLD_CHARGE_MS) return;
  Orb* o = findOrb(holdId);
  if (!o) return;
  longFired = true;
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
  lcd.drawString("screenbox", W / 2, H / 2);

  frame.setColorDepth(16);
  frame.setPsram(true);
  if (!frame.createSprite(W, H)) Serial.println("[ui] frame sprite alloc FAILED");
  buildFloor();
  scratch.setColorDepth(16);
  scratch.createSprite(SCRATCH_W, SCRATCH_H);
  Serial.printf("[ui] sprites ready, free heap=%u psram=%u\n", ESP.getFreeHeap(), ESP.getFreePsram());
}

void loop() {
  uint32_t now = millis();
  uint16_t tx, ty;
  bool touched = lcd.getTouch(&tx, &ty);
  if (touched && !wasTouched)      onDown(tx, ty, now);
  else if (touched && wasTouched)  onMove(tx, ty, now);
  else if (!touched && wasTouched) onUp(tx, ty, now);
  wasTouched = touched;
  checkLongPress(now);
  if (selectedId.length() && hold == Hold::None && now - lastInteractMs > SELECT_TIMEOUT_MS) selectedId = "";

  uint32_t v = net::version();
  if (v != seenVersion) { seenVersion = v; syncOrbs(); }

  if (now - lastFrameMs >= 33) {
    animate((now - lastFrameMs) / 1000.f);
    render(now);
    lastFrameMs = now;
  }
  delay(1);
}

}  // namespace ui
