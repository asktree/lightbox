#include "sliders.h"
#include "canvas.h"
#include <stdio.h>

namespace sliders {
namespace {
constexpr int MAXN = 5;
constexpr int SL_H = 16, LABEL_W = 22, VALUE_W = 30;
struct Placed { Slider s; int x, y, w; };
Placed all[MAXN];
int n = 0, active = -1;

inline uint16_t rgb(int r, int g, int b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
inline int trackX0(const Placed& p) { return p.x + LABEL_W; }
inline int trackX1(const Placed& p) { return p.x + p.w - VALUE_W; }
}  // namespace

void begin(const Slider* top, int nTop, const Slider* bottom) {
  using canvas::W; using canvas::H;
  const int HALF = W / 2;
  n = 0;
  for (int i = 0; i < nTop && n < MAXN - 1; ++i, ++n)
    all[n] = {top[i], (i & 1) ? HALF + 2 : 2, 2 + (i / 2) * SL_H, HALF - 4};
  if (bottom) all[n++] = {*bottom, 2, H - SL_H - 2, W - 4};
}

bool touch(bool down, int tx, int ty) {
  if (!down) { active = -1; return false; }
  if (active < 0) {
    for (int i = 0; i < n; ++i) {
      const Placed& p = all[i];
      if (ty >= p.y - 6 && ty < p.y + SL_H + 6 && tx >= p.x && tx < p.x + p.w) { active = i; break; }
    }
    if (active < 0) return false;
  }
  const Placed& p = all[active];
  float f = (tx - trackX0(p)) / (float)(trackX1(p) - trackX0(p));
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  *p.s.val = p.s.lo + (p.s.hi - p.s.lo) * f;
  return true;
}

void draw(LGFX_Sprite& frame) {
  frame.setFont(&fonts::Font0);
  char buf[12];
  for (int i = 0; i < n; ++i) {
    const Placed& p = all[i];
    bool hot = (i == active);
    int cy = p.y + SL_H / 2, x0 = trackX0(p), x1 = trackX1(p);
    frame.setTextColor(hot ? rgb(255, 255, 255) : rgb(120, 120, 120));
    frame.setTextDatum(textdatum_t::middle_left);
    frame.drawString(p.s.label, p.x, cy);
    frame.drawFastHLine(x0, cy, x1 - x0, rgb(60, 60, 60));
    float f = (*p.s.val - p.s.lo) / (p.s.hi - p.s.lo);
    int kx = x0 + (int)((x1 - x0) * f + 0.5f);
    frame.drawRect(kx - 2, cy - 2, 5, 5, hot ? rgb(255, 255, 255) : rgb(170, 170, 170));
    float v = *p.s.val;
    snprintf(buf, sizeof buf, v < 10 ? "%.2f" : "%.1f", v);
    frame.setTextDatum(textdatum_t::middle_right);
    frame.drawString(buf, p.x + p.w, cy);
  }
}
}  // namespace sliders
