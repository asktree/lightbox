// ─── Blind endpoint ─────────────────────────────────────────────────────────
//
// The C6 is the Zigbee *coordinator*: it owns the network and the blind joins
// it directly. This endpoint is the coordinator's side of the conversation —
// it discovers the blind when it joins, figures out which dialect it speaks,
// and translates open/close/stop/go-to into that dialect.
//
// Two dialects exist in the wild for Zigbee blinds:
//   ZCL  — the standard Window Covering cluster (0x0102). Position is
//          "lift percentage": 0 = fully open, 100 = fully closed.
//   Tuya — a Tuya MCU behind cluster 0xEF00 speaking "datapoints" (DPs).
//          DP1 = control (open/stop/close), DP2 = go-to %, DP3 = position %.
//
// Everything leaving this module speaks *openness*: 0 = closed, 100 = open.
// That's the only number the rest of the system ever sees.

#pragma once
#include <Zigbee.h>

namespace blind {

enum class Protocol : uint8_t { Unknown = 0, Zcl = 1, Tuya = 2 };
const char *protocolName(Protocol p);

// What the outside world needs to know. `open` is 0..100, or -1 if the
// blind hasn't told us yet. `dir` is +1 opening, -1 closing, 0 still.
struct State {
  bool paired;
  bool pairing;      // network is open for joining right now
  Protocol protocol;
  int open;
  bool moving;
  int dir;
  int target;        // -1 when not heading to a specific %
  uint16_t shortAddr;
  uint8_t endpoint;
  uint32_t travelMs;  // time for a full travel as the motor gives it; 0 = not known
};

// A raw frame for experiments on the motor: travel limits and direction
// (HANDOVER §6.2). The answer from the blind goes to the log (GET /log).
struct Probe {
  enum class Op : uint8_t { TuyaQuery, TuyaWrite, AttrRead, AttrWrite };
  Op op;
  uint8_t dp;        // TuyaWrite: datapoint id
  uint8_t type;      // TuyaWrite: 1 bool, 2 value, 4 enum, 5 bitmap. AttrWrite: ZCL type id
  uint16_t cluster;  // AttrRead, AttrWrite
  uint16_t attr;
  uint16_t manuf;    // AttrRead, AttrWrite: manufacturer code, 0 = none
  uint32_t value;
};

class BlindEndpoint : public ZigbeeEP {
public:
  explicit BlindEndpoint(uint8_t endpoint);

  // ─── Lifecycle (call from setup/loop, outside the Zigbee task) ──────────
  void restore();          // load the paired blind from NVS
  void tick();             // movement inference; call every loop
  void startPairing(uint8_t seconds);
  void forget();

  // ─── Commands (openness: 0 closed … 100 open) ───────────────────────────
  bool open();
  bool close();
  bool stop();
  bool goTo(int openPct);
  void refresh();          // ask the blind for its current position
  bool probe(const Probe &p);  // send a raw frame; does not change the state
  void setInverted(bool inverted);
  void setProtocol(Protocol p);  // override the auto-detected dialect
  bool inverted() const { return _inverted; }

  State state() const;

private:
  // ─── Zigbee callbacks (run inside the Zigbee task) ──────────────────────
  void findEndpoint(esp_zb_zdo_match_desc_req_param_t *req) override;
  void zbAttributeRead(uint16_t cluster, const esp_zb_zcl_attribute_t *attr, uint8_t srcEp, esp_zb_zcl_addr_t src) override;
  void zbCustomClusterCommand(const esp_zb_zcl_custom_cluster_command_message_t *msg) override;
  void zbWriteAttributeResponse(uint16_t cluster, uint16_t attr, esp_zb_zcl_status_t status, uint8_t srcEp, esp_zb_zcl_addr_t src) override;

  static void onActiveEndpoints(esp_zb_zdp_status_t status, uint8_t count, uint8_t *eps, void *ctx);
  static void onSimpleDescriptor(esp_zb_zdp_status_t status, esp_zb_af_simple_desc_1_1_t *desc, void *ctx);
  static void onBind(esp_zb_zdp_status_t status, void *ctx);

  void adopt(uint16_t shortAddr, uint8_t ep, Protocol proto);
  void configure();        // bind + reporting (ZCL) or wake-up queries (Tuya)
  void onPosition(int raw);
  void tuyaDatapoint(uint8_t dp, uint8_t type, const uint8_t *val, uint16_t len);

  // ─── Wire helpers (caller holds the Zigbee lock) ────────────────────────
  void zclCommand(uint8_t cmd, uint8_t *value);
  void tuyaSend(uint8_t dp, uint8_t type, const uint8_t *val, uint8_t len);
  void readAttrs(uint16_t cluster, uint16_t *attrs, uint8_t count, uint16_t manuf = 0);
  void writeAttr(uint16_t cluster, uint16_t attr, uint8_t type, uint32_t value, uint16_t manuf);

  void persist();
  void beginMove(int dir, int target);

  // Paired device
  esp_zb_ieee_addr_t _ieee{};
  uint16_t _short = 0xFFFF;
  uint8_t _ep = 0;
  Protocol _proto = Protocol::Unknown;
  bool _inverted = false;

  // Live state
  volatile int _open = -1;
  volatile bool _moving = false;
  volatile int _dir = 0;
  volatile int _target = -1;
  volatile uint32_t _moveStartMs = 0;
  volatile uint32_t _lastReportMs = 0;
  volatile bool _reportSinceMove = false;
  uint32_t _pairingUntilMs = 0;
  uint16_t _tuyaSeq = 0;
  // The motor gives its position as Tuya dp 3. Then that is the only
  // position source; its ZCL lift attribute can be stale. Kept in NVS.
  bool _tuyaPos = false;
  volatile uint32_t _travelMs = 0;
};

}  // namespace blind
