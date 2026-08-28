// tunnel: flying down a tunnel of spinning, parallaxing clouds.
//
// Classic tunnel mapping: every screen pixel has a precomputed (angle, depth)
// pair, where depth = K / radius from the vanishing point. Three nested cloud
// cylinders of different radii are texture-mapped through that table with
// their own scroll (flight) and rotation (spin) offsets -- because each
// cylinder has its own K the layers slide past each other with real parallax.
// The cloud textures are tileable "alligator" cellular noise (billowy lumps,
// like the Houdini noise the reference shader uses), lit from one side by a
// cheap slope shade, silhouetted against a bright light at the end of the
// tunnel. Everything is 8-bit tone, mapped through the comet palette bank.
#include <Arduino.h>
#include <math.h>
#include "canvas.h"
#include "ota.h"
#include "../comet/curves.h"

using canvas::frame;
using canvas::W;
using canvas::H;

namespace {

constexpr int   TEX_A = 256, TEX_D = 128;              // cloud texture: angle x depth, both tile
constexpr int   LAYERS = 3;
constexpr float CX = W * 0.5f, CY = H * 0.46f;         // vanishing point, a little above centre
constexpr int   K0 = 22 * 256;                         // depth scale: depth = K0 / r (8.8)

// per layer: cylinder radius factor (parallax), spin and flight speeds, density threshold
struct Layer { float radius, spin, fly; int thresh, seed; };
const Layer layers[LAYERS] = {
  {1.00f,  0.030f, 0.55f, 120, 11},                    // far, small: slow
  {1.55f, -0.045f, 0.95f, 128, 23},                    // middle, counter-spinning
  {2.40f,  0.070f, 1.60f, 140, 37},                    // near, big: fast
};

uint8_t* angleTab = nullptr;                           // per pixel angle 0..255
uint16_t* depthTab = nullptr;                          // per pixel depth 8.8 (wraps through the texture)
uint8_t* radTab = nullptr;                             // per pixel normalised radius 0..255 (for the end-light + fog)
uint8_t* tex[LAYERS];                                  // TEX_D x TEX_A tone textures

uint16_t grayRaw[256], grayRawD[4][256];
bool swapBytes = false;
uint16_t* buf = nullptr;
int curveIdx = 2;                                      // forge: sunset clouds
uint32_t labelUntil = 1500;

uint32_t rng = 0x2545F491u;
inline uint32_t xr() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
inline float frand() { return (xr() & 0xFFFFFF) / 16777216.f; }
inline uint32_t hash2(int x, int y, int s) { uint32_t h = (uint32_t)x * 374761393u + (uint32_t)y * 668265263u + (uint32_t)s * 2246822519u; h = (h ^ (h >> 13)) * 1274126177u; return h ^ (h >> 16); }
inline float smooth01(float t) { return t * t * (3.f - 2.f * t); }

// Tileable alligator noise: for each lattice cell a random feature point with a
// random strength; value = strongest minus second strongest smooth falloff.
// Gives crisp-edged billowy lumps rather than the mush of value noise.
float alligator(float u, float v, int cellsU, int cellsV, int seed) {
  float pu = u * cellsU, pv = v * cellsV;
  int iu = (int)floorf(pu), iv = (int)floorf(pv);
  float d1 = 0, d2 = 0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    int cu = iu + x, cv = iv + y;
    int wu = ((cu % cellsU) + cellsU) % cellsU, wv = ((cv % cellsV) + cellsV) % cellsV;   // wrap: tileable
    uint32_t h = hash2(wu, wv, seed);
    float fx = cu + ((h & 0xFF) / 255.f), fy = cv + (((h >> 8) & 0xFF) / 255.f);
    float dx = pu - fx, dy = pv - fy, dd = dx * dx + dy * dy;
    if (dd < 1.f) {
      float d = (((h >> 16) & 0xFF) / 255.f) * smooth01(1.f - sqrtf(dd));
      if (d > d1) { d2 = d1; d1 = d; } else if (d > d2) d2 = d;
    }
  }
  return d1 - d2;
}

void buildTextures() {
  for (int L = 0; L < LAYERS; L++) {
    tex[L] = (uint8_t*)heap_caps_malloc(TEX_A * TEX_D, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!tex[L]) tex[L] = (uint8_t*)malloc(TEX_A * TEX_D);
    int seed = layers[L].seed;
    for (int d = 0; d < TEX_D; d++) {
      float v = d / (float)TEX_D;
      for (int a = 0; a < TEX_A; a++) {
        float u = a / (float)TEX_A;
        // three octaves; the angle axis is twice as long as depth so cells stay roughly square
        float n = alligator(u, v, 8, 4, seed) * 0.55f
                + alligator(u, v, 16, 8, seed + 1) * 0.30f
                + alligator(u, v, 32, 16, seed + 2) * 0.15f;
        n = n * 2.6f;                                  // alligator sits low; stretch to fill 0..1
        if (n > 1) n = 1;
        tex[L][d * TEX_A + a] = (uint8_t)(n * 255.f);
      }
    }
    Serial.printf("[tunnel] layer %d texture built\n", L);
  }
}

void buildTables() {
  angleTab = (uint8_t*)heap_caps_malloc(W * H, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  depthTab = (uint16_t*)heap_caps_malloc(W * H * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  radTab   = (uint8_t*)heap_caps_malloc(W * H, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  const float rMax = sqrtf(CX * CX + CY * CY);
  for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
    float dx = x - CX, dy = y - CY;
    float r = sqrtf(dx * dx + dy * dy);
    if (r < 1.5f) r = 1.5f;
    float a = atan2f(dy, dx);                          // -pi..pi
    int i = y * W + x;
    angleTab[i] = (uint8_t)((a + (float)M_PI) * (256.f / (2.f * (float)M_PI)));
    depthTab[i] = (uint16_t)fminf(65535.f, K0 / r * 8.f);   // 8.8 texture rows
    radTab[i] = (uint8_t)fminf(255.f, r / rMax * 255.f);
  }
}

void buildToneLut() {
  static const int bay[4] = {0, 2, 3, 1};
  for (int g = 0; g < 256; g++) {
    int r = CURVES[curveIdx][0][g], gg = CURVES[curveIdx][1][g], b = CURVES[curveIdx][2][g];
    uint16_t c = ((r & 0xF8) << 8) | ((gg & 0xFC) << 3) | (b >> 3);
    grayRaw[g] = swapBytes ? __builtin_bswap16(c) : c;
    for (int k = 0; k < 4; k++) {
      int o5 = bay[k] * 2, o6 = bay[k];
      int rr = min(255, r + o5), g2 = min(255, gg + o6), bb = min(255, b + o5);
      uint16_t cd = ((rr & 0xF8) << 8) | ((g2 & 0xFC) << 3) | (bb >> 3);
      grayRawD[k][g] = swapBytes ? __builtin_bswap16(cd) : cd;
    }
  }
}
inline uint16_t toneColor565(int g) { uint16_t v = grayRaw[g < 0 ? 0 : g > 255 ? 255 : g]; return swapBytes ? __builtin_bswap16(v) : v; }

// ---- render ------------------------------------------------------------------
float spin[LAYERS] = {0, 0, 0}, fly[LAYERS] = {0, 0, 0};
float lookX = 0, lookY = 0;                            // touch: bank the view (texture-space, cheap)

void render(uint32_t now) {
  // light at the end of the tunnel, and fog: the deeper (smaller r) the brighter
  static uint8_t endLight[256];
  static bool lit = false;
  if (!lit) { for (int i = 0; i < 256; i++) { float t = i / 255.f; endLight[i] = (uint8_t)(255.f * (0.10f + 0.90f * powf(1.f - t, 2.2f))); } lit = true; }

  int spinI[LAYERS], flyI[LAYERS], thresh[LAYERS];
  for (int L = 0; L < LAYERS; L++) {
    spinI[L] = (int)(spin[L] * 256.f) & 0xFF;
    flyI[L] = (int)(fly[L] * 256.f);                   // 8.8
    thresh[L] = layers[L].thresh;
  }
  const int kR[LAYERS] = {(int)(layers[0].radius * 256), (int)(layers[1].radius * 256), (int)(layers[2].radius * 256)};
  const int lookA = (int)(lookX * 24.f), lookD = (int)(lookY * 40.f * 256.f);

  for (int y = 0; y < H; y++) {
    uint16_t* row = buf + y * W;
    const int i0 = y * W;
    for (int x = 0; x < W; x++) {
      const int i = i0 + x;
      const int a = angleTab[i], dpt = depthTab[i], rad = radTab[i];
      // start from the light at the far end, dimmed by how far out we look
      int tone = endLight[rad];
      // composite far -> near; each layer is a translucent cloud slab
      for (int L = 0; L < LAYERS; L++) {
        int u = (a + spinI[L] + lookA) & (TEX_A - 1);
        int v = ((((dpt * kR[L]) >> 8) + flyI[L] + lookD) >> 8) & (TEX_D - 1);
        const uint8_t* t = tex[L] + v * TEX_A;
        int n = t[u];
        if (n <= thresh[L]) continue;                  // thin air
        int alpha = (n - thresh[L]) * 3; if (alpha > 255) alpha = 255;
        // side light: slope along the angle axis (sun to one side of the tunnel)
        int slope = t[(u + 2) & (TEX_A - 1)] - t[(u - 2) & (TEX_A - 1)];
        // the cloud's own brightness: lit by the end-light behind it (backlit rim
        // near the middle, dark up close) plus the side shade
        int lightHere = endLight[rad] >> 1;            // clouds are darker than the void behind them
        int cloud = lightHere + (slope >> 1) + 20;
        // depth fog toward the far end so the innermost rings blend into the light
        int fog = 255 - endLight[rad];
        cloud = (cloud * fog + 255 * (255 - fog)) >> 8;
        if (cloud < 0) cloud = 0; if (cloud > 255) cloud = 255;
        tone = (cloud * alpha + tone * (255 - alpha)) >> 8;
      }
      row[x] = grayRawD[((y & 1) << 1) | (x & 1)][tone];
    }
  }
}

uint32_t lastMs = 0, frames = 0, perfMs = 0;
const char* modeLabel = nullptr;

}  // namespace

void setup() {
  Serial.setTxBufferSize(4096);
  Serial.begin(115200);
  delay(100);
  Serial.printf("\n[tunnel] %dx%d\n", W, H);
  canvas::begin();
  buf = (uint16_t*)frame.getBuffer();
  frame.drawPixel(0, 0, (uint16_t)0xF800);
  swapBytes = (*(uint16_t*)frame.getBuffer() != 0xF800);
  buildToneLut();
  frame.fillScreen(TFT_BLACK);
  frame.setFont(&fonts::Font0); frame.setTextDatum(textdatum_t::middle_center);
  frame.setTextColor(toneColor565(160)); frame.drawString("building clouds", W / 2, H / 2);
  canvas::present();
  uint32_t t0 = millis();
  buildTables();
  buildTextures();
  Serial.printf("[tunnel] tables + textures in %lu ms, heap=%u psram=%u\n", (unsigned long)(millis() - t0), ESP.getFreeHeap(), ESP.getFreePsram());
  ota::begin();
  lastMs = millis();
}

void loop() {
  uint32_t now = millis();
  float dt = (now - lastMs) / 1000.f;
  if (dt < 0.016f) { delay(1); return; }
  if (dt > 0.05f) dt = 0.05f;
  lastMs = now;

  // touch: look/bank toward the finger (shifts the texture lookups; no table rebuild)
  int tx, ty;
  static bool wasDown = false; static uint32_t downMs = 0; static int downX = 0, downY = 0; static bool dragged = false;
  bool down = canvas::touch(tx, ty);
  float lookTX = 0, lookTY = 0;
  if (down && !wasDown) { downMs = now; downX = tx; downY = ty; dragged = false; }
  if (down) {
    if (abs(tx - downX) > 8 || abs(ty - downY) > 8) dragged = true;
    lookTX = (tx - W * 0.5f) / (W * 0.5f); lookTY = (ty - H * 0.5f) / (H * 0.5f);
  }
  if (!down && wasDown && !dragged && now - downMs < 400) {
    curveIdx = (curveIdx + 1) % N_CURVES;
    buildToneLut();
    labelUntil = now + 1500;
  }
  wasDown = down;
  float ease = fminf(1.f, (down ? 4.f : 2.f) * dt);
  lookX += (lookTX - lookX) * ease; lookY += (lookTY - lookY) * ease;

  for (int L = 0; L < LAYERS; L++) { spin[L] += layers[L].spin * dt; fly[L] += layers[L].fly * dt; }

  render(now);
  {
    float a = now < labelUntil ? 1.f : 1.f - (now - labelUntil) / 500.f;
    if (a > 0.02f) {
      frame.setFont(&fonts::Font0); frame.setTextDatum(textdatum_t::bottom_left);
      frame.setTextColor(toneColor565((int)(230 * a)));
      frame.drawString(CURVE_NAMES[curveIdx], W / 10, H - H / 10);
    }
  }
  if (!ota::online()) frame.drawPixel(W - 2, 1, toneColor565(90));
  canvas::present();

  frames++;
  if (now - perfMs > 5000) {
    Serial.printf("[tunnel] %.1f fps, heap=%u\n", frames * 1000.f / (now - perfMs), ESP.getFreeHeap());
    frames = 0; perfMs = now;
  }
}
