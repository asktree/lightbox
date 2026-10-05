#include "radio.h"

#include <esp_ieee802154.h>

#include "logbuf.h"
#include "net.h"

namespace radio {

// Let the HTTP reply leave on Wi-Fi before the radio changes owner.
static constexpr uint32_t LEAD_MS = 60;
// Let the new priorities take effect before the frame is queued.
static constexpr uint32_t SETTLE_MS = 20;
// A window that opens when Wi-Fi has just connected makes Wi-Fi lose the
// access point for 20 s or more (measured with a window 2 s after the
// connect). Keep the command and wait until Wi-Fi is this old.
static constexpr uint32_t WIFI_SETTLE_MS = 8000;
// The answer to a probe comes after the acknowledge, sometimes as more than
// one frame. Keep the window open at least this long for it.
static constexpr uint32_t PROBE_HOLD_MS = 3000;

static blind::BlindEndpoint *s_shade = nullptr;
static esp_ieee802154_coex_config_t s_wifiCoex;  // stock, read at boot
static const esp_ieee802154_coex_config_t s_zigbeeCoex = {
  .idle = IEEE802154_HIGH,
  .txrx = IEEE802154_HIGH,
  .txrx_at = IEEE802154_HIGH,
};

static uint32_t s_holdMs = 400;
// The parent keeps a frame for a sleepy child for 7.68 s. After that the
// frame is gone, so a longer window gives nothing. But Wi-Fi loses the access
// point after about 8 s in Zigbee mode (measured), so stay below that. The
// blind acknowledges in about 0.4 s when it is in range.
static uint32_t s_maxMs = 6000;

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static Kind s_pendingKind = Kind::None;
static int s_pendingArg = 0;
static blind::Probe s_pendingProbe = {};
static uint32_t s_pendingAtMs = 0;

static volatile bool s_zigbee = false;
// Send a command at once in Wi-Fi mode, with no window (setWindowless).
// Measured with the blind in range: 28 of 28 commands acknowledged, in
// 0.06 s to 0.63 s, the same as with a window. With steady Wi-Fi traffic
// some acknowledges came after 1 s to 2 s, so a window opens as a fallback.
static volatile bool s_windowless = true;
// In windowless mode, open a window if no acknowledge came in this time.
// The blind polls about each 0.6 s; this is a little more than one poll.
static constexpr uint32_t FALLBACK_MS = 750;
static volatile bool s_awaiting = false;  // a command is sent, no acknowledge yet
static volatile bool s_probing = false;   // that command is a probe
static volatile uint32_t s_sentAtMs = 0;
static volatile uint32_t s_closeAtMs = 0;  // window end when not awaiting
static volatile uint32_t s_holdUntilMs = 0;
static volatile bool s_holdUntilHeard = false;
static uint32_t s_enteredAtMs = 0;

static volatile uint32_t s_windows = 0;
static volatile uint32_t s_timeouts = 0;
static volatile int32_t s_ackMs = -1;
static volatile uint32_t s_windowMs = 0;
static volatile uint32_t s_lastHeardMs = 0;
static volatile bool s_everHeard = false;

static bool due(uint32_t at) { return (int32_t)(millis() - at) >= 0; }

static void enterZigbee() {
  esp_ieee802154_set_coex_config(s_zigbeeCoex);
  s_zigbee = true;
  s_enteredAtMs = millis();
  s_windows++;
  logbuf::line("[radio] zigbee window open");
}

static void enterWifi() {
  esp_ieee802154_set_coex_config(s_wifiCoex);
  s_zigbee = false;
  s_windowMs = millis() - s_enteredAtMs;
  logbuf::line("[radio] back to wifi after %lu ms (ack %ld ms)", (unsigned long)s_windowMs, (long)s_ackMs);
}

// Delivery report from the stack. For a sleepy child this fires when the
// child polled and took the frame.
static void onSendStatus(esp_zb_zcl_command_send_status_message_t msg) {
  if (msg.status == ESP_OK) {
    heard();
    return;
  }
  logbuf::line("[radio] send failed: %s", esp_err_to_name(msg.status));
}

void begin(blind::BlindEndpoint &shade) {
  s_shade = &shade;
  s_wifiCoex = esp_ieee802154_get_coex_config();
  logbuf::line("[radio] wifi-mode 802.15.4 priority idle=%d txrx=%d txrx_at=%d (1 high .. 4 idle)", s_wifiCoex.idle, s_wifiCoex.txrx, s_wifiCoex.txrx_at);
  esp_zb_lock_acquire(portMAX_DELAY);
  esp_zb_zcl_command_send_status_handler_register(onSendStatus);
  esp_zb_lock_release();
}

bool submit(Kind kind, int arg) {
  if (!s_shade || !s_shade->state().paired) return false;
  portENTER_CRITICAL(&s_mux);
  s_pendingKind = kind;
  s_pendingArg = arg;
  s_pendingAtMs = millis();
  portEXIT_CRITICAL(&s_mux);
  return true;
}

bool submitProbe(const blind::Probe &probe) {
  if (!s_shade || !s_shade->state().paired) return false;
  portENTER_CRITICAL(&s_mux);
  s_pendingKind = Kind::Probe;
  s_pendingArg = 0;
  s_pendingProbe = probe;
  s_pendingAtMs = millis();
  portEXIT_CRITICAL(&s_mux);
  return true;
}

void hold(uint32_t ms, bool untilHeard) {
  s_holdUntilHeard = untilHeard;
  s_holdUntilMs = millis() + ms;
  if (!s_zigbee) enterZigbee();
}

void heard() {
  uint32_t now = millis();
  s_lastHeardMs = now;
  s_everHeard = true;
  if (s_awaiting) {
    s_awaiting = false;
    s_ackMs = (int32_t)(now - s_sentAtMs);
    s_closeAtMs = now + (s_probing ? max(s_holdMs, PROBE_HOLD_MS) : s_holdMs);
  }
  if (s_holdUntilHeard) {
    // Leave a few seconds for the bind and report setup after a rejoin.
    s_holdUntilHeard = false;
    s_holdUntilMs = now + 3000;
  }
}

void tune(uint32_t holdMs, uint32_t maxMs) {
  s_holdMs = constrain(holdMs, 0UL, 10000UL);
  s_maxMs = constrain(maxMs, 500UL, 30000UL);
  logbuf::line("[radio] hold=%lu ms max=%lu ms", (unsigned long)s_holdMs, (unsigned long)s_maxMs);
}

void setWindowless(bool on) {
  s_windowless = on;
  logbuf::line("[radio] windowless=%d", on);
}

// Wi-Fi must be settled before a window opens. With no Wi-Fi at all, do not
// hold a command from the console for ever.
static bool wifiSettled() {
  if (net::connected()) return net::connectedForMs() >= WIFI_SETTLE_MS;
  return millis() > 30000;
}

static void send(Kind kind, int arg, const blind::Probe &probe) {
  switch (kind) {
    case Kind::Open: s_shade->open(); break;
    case Kind::Close: s_shade->close(); break;
    case Kind::Stop: s_shade->stop(); break;
    case Kind::Go: s_shade->goTo(arg); break;
    case Kind::Refresh: s_shade->refresh(); break;
    case Kind::Probe: s_shade->probe(probe); break;
    default: return;
  }
  s_probing = kind == Kind::Probe;
  s_sentAtMs = millis();
  s_awaiting = true;
}

void tick() {
  portENTER_CRITICAL(&s_mux);
  Kind kind = s_pendingKind;
  int arg = s_pendingArg;
  uint32_t at = s_pendingAtMs;
  portEXIT_CRITICAL(&s_mux);

  if (kind != Kind::None) {
    if (!s_windowless || s_zigbee) {
      if (!s_zigbee) {
        if (!due(at + LEAD_MS)) return;
        if (!wifiSettled()) return;
        enterZigbee();
      }
      if (!due(s_enteredAtMs + SETTLE_MS)) return;
    }
    portENTER_CRITICAL(&s_mux);
    bool same = s_pendingKind == kind && s_pendingArg == arg && s_pendingAtMs == at;
    blind::Probe probe = s_pendingProbe;
    if (same) s_pendingKind = Kind::None;
    portEXIT_CRITICAL(&s_mux);
    if (!same) return;  // a newer command arrived; take it on the next tick
    send(kind, arg, probe);
    return;
  }

  if (!s_zigbee) {
    // No window is open (a windowless send).
    if (!s_awaiting) return;
    if (due(s_sentAtMs + s_maxMs)) {
      s_awaiting = false;
      s_ackMs = -1;
      s_timeouts++;
      logbuf::line("[radio] no acknowledge from the blind (no window)");
    } else if (due(s_sentAtMs + FALLBACK_MS) && wifiSettled()) {
      // The polls of the blind do not get through. Give Zigbee the radio;
      // the frame waits in the stack for the next poll.
      enterZigbee();
    }
    return;
  }
  if (!due(s_holdUntilMs)) return;
  if (s_awaiting) {
    if (!due(s_sentAtMs + s_maxMs)) return;
    s_awaiting = false;
    s_ackMs = -1;
    s_timeouts++;
    logbuf::line("[radio] no acknowledge from the blind in the window");
  } else if (!due(s_closeAtMs)) {
    return;
  }
  // A hold that heard nothing is over. Without this, the next frame from the
  // blind makes its window 3 s longer.
  s_holdUntilHeard = false;
  enterWifi();
}

Stats stats() {
  return Stats{
    .zigbee = s_zigbee,
    .windows = s_windows,
    .timeouts = s_timeouts,
    .ackMs = s_ackMs,
    .windowMs = s_windowMs,
    .heardAgoS = s_everHeard ? (int32_t)((millis() - s_lastHeardMs) / 1000) : -1,
    .holdMs = s_holdMs,
    .maxMs = s_maxMs,
    .windowless = s_windowless,
  };
}

}  // namespace radio
