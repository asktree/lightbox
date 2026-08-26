#include "ui.h"
#include <vector>
#include <math.h>
#include "board.h"
#include "net.h"

namespace ui {
namespace {

board::Display lcd;
LGFX_Sprite    frame(&lcd);   // full-screen back buffer (PSRAM)
LGFX_Sprite    wheel(&lcd);   // pre-rendered HSV disc (PSRAM)

constexpr int W = board::LCD_W, H = board::LCD_H;

// --- layout ------------------------------------------------------------------
constexpr int WHEEL_R  = 112;
constexpr int WHEEL_CX = W / 2;
constexpr int WHEEL_CY = 8 + WHEEL_R;

constexpr int PIN_R = 12;      // web: 16 on a ~600px wheel; scaled for 224px
constexpr int HIT_R = 24;      // finger-sized hit target

constexpr int BAR_X = 20, BAR_Y = 242, BAR_W = W - 40, BAR_H = 12;

constexpr int PILL_Y0 = 266, PILL_H = 20, PILL_ROW = 24, PILL_GAP = 5;
constexpr int STATUS_Y = H - 9;

// --- palette (Tailwind zinc/purple, as in the web client) --------------------
constexpr uint32_t C_BG       = 0x09090b;  // zinc-950
constexpr uint32_t C_ZINC800  = 0x27272a;
constexpr uint32_t C_ZINC700  = 0x3f3f46;
constexpr uint32_t C_ZINC500  = 0x71717a;
constexpr uint32_t C_ZINC400  = 0xa1a1aa;
constexpr uint32_t C_ZINC50   = 0xfafafa;
constexpr uint32_t C_PURPLE   = 0x9333ea;  // purple-600
constexpr uint32_t C_WHITE    = 0xffffff;
constexpr uint32_t C_RED      = 0xf87171;

// --- state -------------------------------------------------------------------
std::vector<net::Light> lights;
uint32_t seenVersion = 0xffffffff;
String   selectedId;

enum class Drag { None, Pin, Bar, Pill };
Drag     drag = Drag::None;
String   dragId;
int      downX = 0, downY = 0;
bool     wasTouched = false;
bool     dirty = true;
uint32_t lastFrameMs = 0;

// captured at bar-drag start: each ON light's brightness / max (web App.tsx)
struct Ratio { String id; float ratio; };
std::vector<Ratio> barRatios;

struct PillRect { String id; int x, y, w; };
std::vector<PillRect> pillRects;

// --- colour maths (same as client hsvToRgb / hsToPosition / positionToHs) ---
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

void hsToPos(int h, int s, int& x, int& y) {
  float a = (h - 90) * (float)M_PI / 180.f;
  float d = (s / 100.f) * WHEEL_R;
  x = WHEEL_CX + (int)roundf(d * cosf(a));
  y = WHEEL_CY + (int)roundf(d * sinf(a));
}

void posToHs(int x, int y, int& h, int& s) {
  float dx = x - WHEEL_CX, dy = y - WHEEL_CY;
  float dist = sqrtf(dx * dx + dy * dy);
  float ang = atan2f(dy, dx) * 180.f / (float)M_PI + 90.f;
  h = (int)roundf(fmodf(fmodf(ang, 360.f) + 360.f, 360.f)) % 360;
  s = (int)roundf(fminf(100.f, dist / WHEEL_R * 100.f));
}

bool showsPin(const net::Light& l) { return l.canColor && l.on && l.reachable; }

const net::Light* findLight(const String& id) {
  for (auto& l : lights) if (l.id == id) return &l;
  return nullptr;
}

int maxBrightness() {
  int m = 0;
  for (auto& l : lights) if (l.on && l.reachable) m = max(m, l.brightness);
  return m;
}

// --- drawing -----------------------------------------------------------------
void buildWheel() {
  const int D = WHEEL_R * 2;
  wheel.setColorDepth(16);
  wheel.setPsram(true);
  wheel.createSprite(D, D);
  for (int y = 0; y < D; y++) {
    for (int x = 0; x < D; x++) {
      float dx = x - WHEEL_R + 0.5f, dy = y - WHEEL_R + 0.5f;
      float dist = sqrtf(dx * dx + dy * dy);
      if (dist > WHEEL_R) { wheel.drawPixel(x, y, C_BG); continue; }
      float ang = atan2f(dy, dx) * 180.f / (float)M_PI + 90.f;
      if (ang < 0) ang += 360.f;
      float sat = dist / WHEEL_R * 100.f;
      uint32_t c = hsvToRgb888(ang, sat, 100.f);
      // centre bloom: white radial gradient over inner 12% (client cosmetic)
      float bloomR = WHEEL_R * 0.12f;
      if (dist < bloomR) {
        float a = 0.7f * (1.f - dist / bloomR);
        uint8_t r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
        r += (255 - r) * a; g += (255 - g) * a; b += (255 - b) * a;
        c = (r << 16) | (g << 8) | b;
      }
      // soft anti-aliased rim
      if (dist > WHEEL_R - 1.f) {
        float a = WHEEL_R - dist;
        uint8_t r = ((c >> 16) & 255) * a + 0x09 * (1 - a);
        uint8_t g = ((c >> 8) & 255) * a + 0x09 * (1 - a);
        uint8_t b = (c & 255) * a + 0x0b * (1 - a);
        c = (r << 16) | (g << 8) | b;
      }
      wheel.drawPixel(x, y, c);
    }
  }
}

void drawLabel(int x, int y, const String& text) {
  frame.setFont(&fonts::Font0);
  frame.setTextDatum(textdatum_t::bottom_center);
  frame.setTextColor(0x000000);
  frame.drawString(text.c_str(), x + 1, y + 1);   // shadow
  frame.setTextColor(C_WHITE);
  frame.drawString(text.c_str(), x, y);
}

void drawPin(const net::Light& l, bool selected, bool dragging) {
  int x, y; hsToPos(l.h, l.s, x, y);
  uint32_t fill = hsvToRgb888(l.h, l.s, 100);
  int border = selected ? 3 : 2;
  frame.fillCircle(x + 1, y + 2, PIN_R + border, 0x000000);       // drop shadow
  frame.fillCircle(x, y, PIN_R + border, C_WHITE);
  frame.fillCircle(x, y, PIN_R, fill);
  if (!dragging) {
    String name = l.name.length() > 16 ? l.name.substring(0, 15) + "…" : l.name;
    drawLabel(x, y - PIN_R - border - 3, name);
  }
}

void drawBar() {
  int m = maxBrightness();
  int fillW = BAR_W * m / 100;
  frame.fillRoundRect(BAR_X, BAR_Y, BAR_W, BAR_H, BAR_H / 2, C_ZINC700);
  if (fillW > 0) frame.fillRoundRect(BAR_X, BAR_Y, max(fillW, BAR_H), BAR_H, BAR_H / 2, C_ZINC50);
  int tx = BAR_X + fillW;
  frame.fillCircle(tx, BAR_Y + BAR_H / 2, BAR_H / 2 + 3, C_BG);
  frame.fillCircle(tx, BAR_Y + BAR_H / 2, BAR_H / 2 + 1, C_WHITE);
}

void drawPills() {
  pillRects.clear();
  frame.setFont(&fonts::Font0);
  frame.setTextDatum(textdatum_t::middle_left);
  int x = 8, y = PILL_Y0;
  for (auto& l : lights) {
    String name = l.name.length() > 14 ? l.name.substring(0, 13) + "…" : l.name;
    int tw = frame.textWidth(name.c_str());
    int w = 8 + 8 + 5 + tw + 8;                    // pad, dot, gap, text, pad
    if (x + w > W - 8) { x = 8; y += PILL_ROW; }
    if (y + PILL_H > STATUS_Y - 6) break;          // out of room
    bool selected = (l.id == selectedId);
    uint32_t bg = selected ? C_PURPLE : C_ZINC800;
    uint32_t fg = selected ? C_WHITE : (l.reachable ? C_ZINC400 : C_ZINC500);
    frame.fillRoundRect(x, y, w, PILL_H, PILL_H / 2, bg);
    uint32_t dot = (l.on && l.hasColor) ? hsvToRgb888(l.h, l.s, 100) : 0x444444;
    if (!l.reachable) dot = 0x333333;
    frame.fillCircle(x + 12, y + PILL_H / 2, 4, dot);
    frame.setTextColor(fg, bg);
    frame.drawString(name.c_str(), x + 21, y + PILL_H / 2);
    pillRects.push_back({l.id, x, y, w});
    x += w + PILL_GAP;
  }
}

void drawStatus() {
  frame.setFont(&fonts::Font0);
  frame.setTextDatum(textdatum_t::bottom_right);
  bool online = net::status() == net::Status::Online;
  frame.fillCircle(W - 6, STATUS_Y - 3, 2, online ? 0x22c55e : C_RED);
  frame.setTextColor(C_ZINC500, C_BG);
  frame.drawString(net::statusText(), W - 12, STATUS_Y);
  frame.setTextDatum(textdatum_t::bottom_left);
  frame.drawString("Living Room", 8, STATUS_Y);
  if (!online) frame.drawRoundRect(0, 0, W, H, 4, C_RED);  // web: red inset ring
}

void render() {
  frame.fillScreen(C_BG);
  wheel.pushSprite(&frame, WHEEL_CX - WHEEL_R, WHEEL_CY - WHEEL_R);
  // unselected pins first so the selected/dragged one sits on top
  for (auto& l : lights) if (showsPin(l) && l.id != selectedId) drawPin(l, false, false);
  if (const net::Light* sel = findLight(selectedId))
    if (showsPin(*sel)) drawPin(*sel, true, drag == Drag::Pin);
  drawBar();
  drawPills();
  drawStatus();
  frame.pushSprite(0, 0);
}

// --- input -------------------------------------------------------------------
const net::Light* pinAt(int x, int y) {
  const net::Light* best = nullptr; int bestD = HIT_R * HIT_R;
  for (auto& l : lights) {
    if (!showsPin(l)) continue;
    int px, py; hsToPos(l.h, l.s, px, py);
    int d = (px - x) * (px - x) + (py - y) * (py - y);
    if (l.id == selectedId) d -= 16;               // slight preference for the selected pin
    if (d < bestD) { bestD = d; best = &l; }
  }
  return best;
}

const PillRect* pillAt(int x, int y) {
  for (auto& p : pillRects)
    if (x >= p.x - 3 && x < p.x + p.w + 3 && y >= p.y - 4 && y < p.y + PILL_H + 4) return &p;
  return nullptr;
}

void applyBar(int x) {
  int newMax = constrain((x - BAR_X) * 100 / BAR_W, 1, 100);
  for (auto& r : barRatios) {
    int b = max(1, (int)roundf(newMax * r.ratio));
    net::setBrightness(r.id, b);
  }
}

void onDown(int x, int y) {
  downX = x; downY = y;
  if (const net::Light* p = pinAt(x, y)) {
    drag = Drag::Pin; dragId = p->id; selectedId = p->id;
    net::startControlling(dragId);
    return;
  }
  if (y >= BAR_Y - 14 && y <= BAR_Y + BAR_H + 14 && x >= BAR_X - 12 && x <= BAR_X + BAR_W + 12) {
    drag = Drag::Bar;
    barRatios.clear();
    int m = maxBrightness();
    for (auto& l : lights)
      if (l.on && l.reachable) barRatios.push_back({l.id, m > 0 ? (float)l.brightness / m : 1.f});
    applyBar(x);
    return;
  }
  if (const PillRect* p = pillAt(x, y)) { drag = Drag::Pill; dragId = p->id; return; }
  drag = Drag::None;
}

void onMove(int x, int y) {
  switch (drag) {
    case Drag::Pin: { int h, s; posToHs(x, y, h, s); net::setColor(dragId, h, s); break; }
    case Drag::Bar: applyBar(x); break;
    default: break;
  }
}

void onUp(int x, int y) {
  switch (drag) {
    case Drag::Pin: net::stopControlling(dragId); break;
    case Drag::Pill: {
      bool moved = abs(x - downX) > 12 || abs(y - downY) > 12;
      const net::Light* l = findLight(dragId);
      if (!moved && l) {
        selectedId = dragId;
        if (l->reachable) net::setOn(dragId, !l->on);   // tap a pill = toggle the light
      }
      break;
    }
    default: break;
  }
  drag = Drag::None; dragId = "";
  dirty = true;
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
  buildWheel();
  Serial.printf("[ui] sprites ready, free heap=%u psram=%u\n", ESP.getFreeHeap(), ESP.getFreePsram());
}

void loop() {
  uint16_t tx, ty;
  bool touched = lcd.getTouch(&tx, &ty);
  if (touched && !wasTouched)      onDown(tx, ty);
  else if (touched && wasTouched)  onMove(tx, ty);
  else if (!touched && wasTouched) onUp(tx, ty);
  wasTouched = touched;

  uint32_t v = net::version();
  if (v != seenVersion) { seenVersion = v; lights = net::lights(); dirty = true; }

  static net::Status lastStatus = net::Status::Booting;
  if (net::status() != lastStatus) { lastStatus = net::status(); dirty = true; }

  uint32_t now = millis();
  if ((dirty || drag != Drag::None) && now - lastFrameMs >= 33) {
    render();
    lastFrameMs = now;
    dirty = false;
  }
  delay(2);
}

}  // namespace ui
