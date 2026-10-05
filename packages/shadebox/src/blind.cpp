#include "blind.h"

#include <Preferences.h>

#include "logbuf.h"
#include "radio.h"

namespace blind {

// ─── Constants ──────────────────────────────────────────────────────────────

static constexpr uint16_t CLUSTER_BASIC = 0x0000;
static constexpr uint16_t CLUSTER_COVERING = 0x0102;
static constexpr uint16_t CLUSTER_TUYA = 0xEF00;
static constexpr uint16_t ATTR_LIFT_PCT = 0x0008;  // CurrentPositionLiftPercentage

// Tuya datapoints for covers (same numbering zigbee2mqtt uses for TS0601 blinds).
static constexpr uint8_t DP_CONTROL = 1;   // enum: 0 open, 1 stop, 2 close
static constexpr uint8_t DP_GOTO = 2;      // value: target %
static constexpr uint8_t DP_POSITION = 3;  // value: current %
static constexpr uint8_t DP_WORK_STATE = 7;  // enum (some models): 0 opening, 1 closing
static constexpr uint8_t DP_TRAVEL_MS = 10;  // value: time for a full travel, in ms
static constexpr uint8_t TUYA_TYPE_VALUE = 0x02;
static constexpr uint8_t TUYA_TYPE_ENUM = 0x04;

// " 01 02 …" for the first bytes of a frame, for the log.
static const char *hexBytes(const uint8_t *p, uint16_t n, char *out, size_t cap) {
  out[0] = 0;
  for (uint16_t i = 0; p && i < n && 3u * (i + 1) < cap; i++) snprintf(out + 3 * i, 4, " %02x", p[i]);
  return out;
}

// Movement inference. Blinds don't reliably say "I've stopped", so we call
// it stopped when position reports go quiet, or after a hard ceiling.
static constexpr uint32_t QUIET_MS = 3500;
static constexpr uint32_t MAX_TRAVEL_MS = 90000;

static const char *protoName(Protocol p) {
  switch (p) {
    case Protocol::Zcl: return "zcl";
    case Protocol::Tuya: return "tuya";
    default: return "unknown";
  }
}

// The ZDO callbacks are plain C function pointers; they reach the (single)
// blind endpoint through this.
static BlindEndpoint *s_self = nullptr;

// RAII holder for the Zigbee stack lock — required for any stack call made
// from outside the Zigbee task (i.e. from loop()).
struct ZbLock {
  ZbLock() { esp_zb_lock_acquire(portMAX_DELAY); }
  ~ZbLock() { esp_zb_lock_release(); }
};

// ─── Construction: the coordinator's endpoint ───────────────────────────────
//
// We're a *client* of the blind's clusters: we send commands and receive
// reports. Tuya's 0xEF00 has to be registered too or the stack drops its
// frames before they reach us.

BlindEndpoint::BlindEndpoint(uint8_t endpoint) : ZigbeeEP(endpoint) {
  s_self = this;
  _device_id = ESP_ZB_HA_WINDOW_COVERING_CONTROLLER_DEVICE_ID;

  esp_zb_basic_cluster_cfg_t basic = {
    .zcl_version = ESP_ZB_ZCL_BASIC_ZCL_VERSION_DEFAULT_VALUE,
    .power_source = 0x01,  // mains
  };
  esp_zb_identify_cluster_cfg_t identify = {.identify_time = 0};

  _cluster_list = esp_zb_zcl_cluster_list_create();
  esp_zb_cluster_list_add_basic_cluster(_cluster_list, esp_zb_basic_cluster_create(&basic), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_basic_cluster(_cluster_list, esp_zb_zcl_attr_list_create(CLUSTER_BASIC), ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);
  esp_zb_cluster_list_add_identify_cluster(_cluster_list, esp_zb_identify_cluster_create(&identify), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_window_covering_cluster(_cluster_list, esp_zb_zcl_attr_list_create(CLUSTER_COVERING), ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);
  esp_zb_cluster_list_add_custom_cluster(_cluster_list, esp_zb_zcl_attr_list_create(CLUSTER_TUYA), ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);

  _ep_config = {
    .endpoint = _endpoint,
    .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
    .app_device_id = ESP_ZB_HA_WINDOW_COVERING_CONTROLLER_DEVICE_ID,
    .app_device_version = 0,
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────
//
// The Zigbee stack remembers the *network* on its own; we remember *which
// device is the blind* and how to talk to it.

void BlindEndpoint::restore() {
  Preferences p;
  p.begin("shadebox", true);
  _proto = (Protocol)p.getUChar("proto", 0);
  _ep = p.getUChar("ep", 0);
  _short = p.getUShort("short", 0xFFFF);
  _inverted = p.getBool("inverted", false);
  _tuyaPos = p.getBool("tuyapos", false);
  p.getBytes("ieee", _ieee, sizeof(_ieee));
  p.end();
  if (_proto != Protocol::Unknown) {
    logbuf::line("[blind] restored %s blind %s ep %u", protoName(_proto), Zigbee.formatIEEEAddress(_ieee), _ep);
  }
}

void BlindEndpoint::persist() {
  Preferences p;
  p.begin("shadebox", false);
  p.putUChar("proto", (uint8_t)_proto);
  p.putUChar("ep", _ep);
  p.putUShort("short", _short);
  p.putBool("inverted", _inverted);
  p.putBool("tuyapos", _tuyaPos);
  p.putBytes("ieee", _ieee, sizeof(_ieee));
  p.end();
}

void BlindEndpoint::forget() {
  _proto = Protocol::Unknown;
  _short = 0xFFFF;
  _ep = 0;
  _open = -1;
  memset(_ieee, 0, sizeof(_ieee));
  persist();
  logbuf::line("[blind] forgotten");
}

void BlindEndpoint::setProtocol(Protocol proto) {
  _proto = proto;
  persist();
  logbuf::line("[blind] protocol=%s", protoName(proto));
}

void BlindEndpoint::setInverted(bool inv) {
  _inverted = inv;
  persist();
  logbuf::line("[blind] inverted=%d", inv);
}

// ─── Pairing & discovery ────────────────────────────────────────────────────
//
// device announce → active endpoints → simple descriptor per endpoint →
// pick the endpoint carrying 0x0102 (preferred) or 0xEF00 → adopt it.

void BlindEndpoint::startPairing(uint8_t seconds) {
  _pairingUntilMs = millis() + seconds * 1000UL;
  radio::hold(seconds * 1000UL);  // a joining device needs the radio all the time
  Zigbee.openNetwork(seconds);
  logbuf::line("[blind] network open for %us — put the blind in pairing mode", seconds);
}

// Called by the Arduino Zigbee core on every device announce (join/rejoin).
void BlindEndpoint::findEndpoint(esp_zb_zdo_match_desc_req_param_t *req) {
  uint16_t addr = req->dst_nwk_addr;
  esp_zb_ieee_addr_t ieee;
  esp_zb_ieee_address_by_short(addr, ieee);
  logbuf::line("[zb] device announce 0x%04x %s", addr, Zigbee.formatIEEEAddress(ieee));

  // Our blind rejoining (e.g. after a power cut) — just track its new address.
  if (_proto != Protocol::Unknown && memcmp(ieee, _ieee, sizeof(ieee)) == 0) {
    radio::heard();
    _short = addr;
    persist();
    logbuf::line("[blind] rejoined as 0x%04x", addr);
    configure();
    return;
  }
  // A stranger. Only interrogate it if we asked for joiners.
  if ((int32_t)(millis() - _pairingUntilMs) > 0) {
    logbuf::line("[zb] not pairing, ignoring");
    return;
  }
  esp_zb_zdo_active_ep_req_param_t ep_req = {.addr_of_interest = addr};
  esp_zb_zdo_active_ep_req(&ep_req, onActiveEndpoints, (void *)(uintptr_t)addr);
}

void BlindEndpoint::onActiveEndpoints(esp_zb_zdp_status_t status, uint8_t count, uint8_t *eps, void *ctx) {
  uint16_t addr = (uint16_t)(uintptr_t)ctx;
  if (status != ESP_ZB_ZDP_STATUS_SUCCESS) {
    logbuf::line("[zb] active ep request failed (%d)", status);
    return;
  }
  logbuf::line("[zb] 0x%04x has %u endpoint(s)", addr, count);
  for (uint8_t i = 0; i < count; i++) {
    esp_zb_zdo_simple_desc_req_param_t req = {.addr_of_interest = addr, .endpoint = eps[i]};
    esp_zb_zdo_simple_desc_req(&req, onSimpleDescriptor, ctx);
  }
}

void BlindEndpoint::onSimpleDescriptor(esp_zb_zdp_status_t status, esp_zb_af_simple_desc_1_1_t *d, void *ctx) {
  uint16_t addr = (uint16_t)(uintptr_t)ctx;
  if (status != ESP_ZB_ZDP_STATUS_SUCCESS || !d) return;

  // Log everything: this is the one moment we learn what the device is.
  logbuf::line("[zb] 0x%04x ep %u profile 0x%04x device 0x%04x", addr, d->endpoint, d->app_profile_id, d->app_device_id);
  bool covering = false, tuya = false;
  char list[150];
  size_t n = 0;
  list[0] = 0;
  for (uint8_t i = 0; i < d->app_input_cluster_count; i++) {
    uint16_t c = d->app_cluster_list[i];
    if (n + 8 < sizeof(list)) n += snprintf(list + n, sizeof(list) - n, " 0x%04x", c);
    covering |= c == CLUSTER_COVERING;
    tuya |= c == CLUSTER_TUYA;
  }
  logbuf::line("[zb]   in :%s", list);
  n = 0;
  list[0] = 0;
  for (uint8_t i = 0; i < d->app_output_cluster_count; i++) {
    if (n + 8 < sizeof(list)) n += snprintf(list + n, sizeof(list) - n, " 0x%04x", d->app_cluster_list[d->app_input_cluster_count + i]);
  }
  logbuf::line("[zb]   out:%s", list);

  if (!s_self) return;
  if (covering) s_self->adopt(addr, d->endpoint, Protocol::Zcl);
  else if (tuya) s_self->adopt(addr, d->endpoint, Protocol::Tuya);
}

void BlindEndpoint::adopt(uint16_t addr, uint8_t ep, Protocol proto) {
  // Standard ZCL wins if a device advertises both.
  if (_proto == Protocol::Zcl && proto == Protocol::Tuya && _short == addr) return;
  _short = addr;
  _ep = ep;
  _proto = proto;
  esp_zb_ieee_address_by_short(addr, _ieee);
  persist();
  logbuf::line("[blind] paired: %s blind 0x%04x ep %u", protoName(proto), addr, ep);
  configure();
}

// Ask the blind to keep us informed. Runs in the Zigbee task (no lock).
void BlindEndpoint::configure() {
  if (_proto == Protocol::Zcl) {
    // Bind the blind's covering cluster to us so reports have somewhere to go…
    esp_zb_zdo_bind_req_param_t bind = {};
    memcpy(bind.src_address, _ieee, sizeof(_ieee));
    bind.src_endp = _ep;
    bind.cluster_id = CLUSTER_COVERING;
    bind.dst_addr_mode = ESP_ZB_ZDO_BIND_DST_ADDR_MODE_64_BIT_EXTENDED;
    esp_zb_get_long_address(bind.dst_address_u.addr_long);
    bind.dst_endp = _endpoint;
    bind.req_dst_addr = _short;
    esp_zb_zdo_device_bind_req(&bind, onBind, this);

    // …and ask for a report on every 1% change (at most each second).
    uint8_t change = 1;
    esp_zb_zcl_config_report_record_t rec = {};
    rec.direction = ESP_ZB_ZCL_REPORT_DIRECTION_SEND;
    rec.attributeID = ATTR_LIFT_PCT;
    rec.attrType = ESP_ZB_ZCL_ATTR_TYPE_U8;
    rec.min_interval = 1;
    rec.max_interval = 300;
    rec.reportable_change = &change;
    esp_zb_zcl_config_report_cmd_t cfg = {};
    cfg.zcl_basic_cmd.dst_addr_u.addr_short = _short;
    cfg.zcl_basic_cmd.dst_endpoint = _ep;
    cfg.zcl_basic_cmd.src_endpoint = _endpoint;
    cfg.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
    cfg.clusterID = CLUSTER_COVERING;
    cfg.record_number = 1;
    cfg.record_field = &rec;
    esp_zb_zcl_config_report_cmd_req(&cfg);

    uint16_t attr = ATTR_LIFT_PCT;
    readAttrs(CLUSTER_COVERING, &attr, 1);
    // The Yoolax motor gives lift 0 to a read after a rejoin, at any height.
    // Its Tuya position (dp 3) is right, so ask for the datapoints too.
    tuyaSend(0, 0, nullptr, 0);
  } else if (_proto == Protocol::Tuya) {
    // Tuya's "magic packet": reading these basic attributes is what makes
    // many Tuya MCUs start talking. Then ask for a dump of every datapoint.
    uint16_t magic[] = {0x0004, 0x0000, 0x0001, 0x0005, 0x0007, 0xFFFE};
    readAttrs(CLUSTER_BASIC, magic, sizeof(magic) / sizeof(magic[0]));
    tuyaSend(0, 0, nullptr, 0);  // dataQuery (cmd 0x03) — see tuyaSend
  }
}

void BlindEndpoint::onBind(esp_zb_zdp_status_t status, void *) {
  logbuf::line("[zb] bind %s", status == ESP_ZB_ZDP_STATUS_SUCCESS ? "ok" : "failed");
}

// ─── Incoming: position reports ─────────────────────────────────────────────

void BlindEndpoint::zbAttributeRead(uint16_t cluster, const esp_zb_zcl_attribute_t *attr, uint8_t, esp_zb_zcl_addr_t src) {
  radio::heard();
  if (cluster == CLUSTER_BASIC) {
    if (attr->id == 0x0004 || attr->id == 0x0005) {
      // Manufacturer / model strings: first byte is the length.
      const uint8_t *s = (const uint8_t *)attr->data.value;
      if (s) logbuf::line("[zb] basic 0x%04x = %.*s", attr->id, s[0], s + 1);
    }
    return;
  }
  if (cluster == CLUSTER_COVERING && attr->id == ATTR_LIFT_PCT) {
    // A motor that also gives a Tuya position: use only that one. Its lift
    // attribute can be stale (see configure()).
    if (attr->data.value && !_tuyaPos) onPosition(*(const uint8_t *)attr->data.value);
    return;
  }
  // All other attributes: a read from a probe, or a report nobody asked for.
  // Multi-byte values are little-endian.
  char hex[3 * 16 + 1];
  logbuf::line("[zb] attr 0x%04x/0x%04x type 0x%02x size %u =%s", cluster, attr->id, attr->data.type, attr->data.size,
               hexBytes((const uint8_t *)attr->data.value, attr->data.size, hex, sizeof(hex)));
}

// The Arduino core calls this only for a write that the blind accepted. A
// refused read or write gives no line at all.
void BlindEndpoint::zbWriteAttributeResponse(uint16_t cluster, uint16_t, esp_zb_zcl_status_t status, uint8_t, esp_zb_zcl_addr_t) {
  radio::heard();
  logbuf::line("[zb] write attr on 0x%04x: status 0x%02x", cluster, status);
}

// Tuya frames: [status][seq] then repeated {dp, type, len(2, BE), value}.
// esp-zigbee hands us the payload after the ZCL header; for Tuya that
// starts with the 2-byte sequence number.
void BlindEndpoint::zbCustomClusterCommand(const esp_zb_zcl_custom_cluster_command_message_t *msg) {
  if (msg->info.cluster != CLUSTER_TUYA) return;
  radio::heard();
  const uint8_t *p = (const uint8_t *)msg->data.value;
  uint16_t n = msg->data.size;
  char hex[3 * 40 + 1];
  logbuf::line("[tuya] cmd 0x%02x len %u:%s", msg->info.command.id, n, hexBytes(p, n, hex, sizeof(hex)));
  if (n < 2) return;
  for (uint16_t i = 2; i + 4 <= n;) {
    uint8_t dp = p[i], type = p[i + 1];
    uint16_t len = (p[i + 2] << 8) | p[i + 3];
    if (i + 4 + len > n) break;
    tuyaDatapoint(dp, type, p + i + 4, len);
    i += 4 + len;
  }
}

void BlindEndpoint::tuyaDatapoint(uint8_t dp, uint8_t type, const uint8_t *v, uint16_t len) {
  uint32_t value = 0;
  for (uint16_t i = 0; i < len && i < 4; i++) value = (value << 8) | v[i];
  logbuf::line("[tuya] dp %u type %u len %u = %lu", dp, type, len, (unsigned long)value);
  if (dp == DP_POSITION) {
    if (!_tuyaPos) {
      _tuyaPos = true;
      persist();
    }
    onPosition((int)value);
  } else if (dp == DP_TRAVEL_MS) {
    _travelMs = value;
  }
}

// Every dialect funnels into here with its *raw* position number.
void BlindEndpoint::onPosition(int raw) {
  // ZCL lift % is "how closed"; Tuya % is usually "how open". `inverted`
  // flips whichever convention turns out wrong for this particular motor.
  int open = _proto == Protocol::Zcl ? 100 - raw : raw;
  if (_inverted) open = 100 - open;
  open = constrain(open, 0, 100);

  int prev = _open;
  _open = open;
  _lastReportMs = millis();
  if (_moving && prev != open) _reportSinceMove = true;
  if (_moving && _target >= 0 && abs(open - _target) <= 1) _moving = false, _dir = 0;
  if (_moving && _target < 0 && (open == 0 || open == 100)) _moving = false, _dir = 0;
  logbuf::line("[blind] open=%d%% (raw %d)%s", open, raw, _moving ? " (moving)" : "");
}

// ─── Movement inference ─────────────────────────────────────────────────────

void BlindEndpoint::beginMove(int dir, int target) {
  _moving = dir != 0;
  _dir = dir;
  _target = target;
  _moveStartMs = millis();
  _reportSinceMove = false;
}

void BlindEndpoint::tick() {
  if (!_moving) return;
  uint32_t now = millis();
  bool quiet = _reportSinceMove && now - _lastReportMs > QUIET_MS;
  bool timeout = now - _moveStartMs > MAX_TRAVEL_MS;
  if (quiet || timeout) {
    _moving = false;
    _dir = 0;
    logbuf::line("[blind] settled at %d%% (%s)", (int)_open, quiet ? "quiet" : "timeout");
  }
}

// ─── Outgoing: commands ─────────────────────────────────────────────────────

void BlindEndpoint::zclCommand(uint8_t cmd, uint8_t *value) {
  esp_zb_zcl_window_covering_cluster_send_cmd_req_t req = {};
  req.zcl_basic_cmd.dst_addr_u.addr_short = _short;
  req.zcl_basic_cmd.dst_endpoint = _ep;
  req.zcl_basic_cmd.src_endpoint = _endpoint;
  req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  req.cmd_id = cmd;
  req.value = value;
  esp_zb_zcl_window_covering_cluster_send_cmd_req(&req);
}

// dp == 0 means "dataQuery" (cmd 0x03, empty payload) rather than a write.
void BlindEndpoint::tuyaSend(uint8_t dp, uint8_t type, const uint8_t *val, uint8_t len) {
  uint8_t buf[16];
  uint8_t n = 0;
  uint16_t seq = ++_tuyaSeq;
  if (dp) {
    buf[n++] = seq >> 8;
    buf[n++] = seq & 0xFF;
    buf[n++] = dp;
    buf[n++] = type;
    buf[n++] = 0;
    buf[n++] = len;
    memcpy(buf + n, val, len);
    n += len;
  }
  esp_zb_zcl_custom_cluster_cmd_req_t req = {};
  req.zcl_basic_cmd.dst_addr_u.addr_short = _short;
  req.zcl_basic_cmd.dst_endpoint = _ep;
  req.zcl_basic_cmd.src_endpoint = _endpoint;
  req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  req.profile_id = ESP_ZB_AF_HA_PROFILE_ID;
  req.cluster_id = CLUSTER_TUYA;
  req.direction = ESP_ZB_ZCL_CMD_DIRECTION_TO_SRV;
  req.custom_cmd_id = dp ? 0x00 : 0x03;
  req.data.type = ESP_ZB_ZCL_ATTR_TYPE_SET;  // raw bytes, no length prefix
  req.data.size = n;
  req.data.value = n ? buf : nullptr;
  esp_zb_zcl_custom_cluster_cmd_req(&req);
}

void BlindEndpoint::readAttrs(uint16_t cluster, uint16_t *attrs, uint8_t count, uint16_t manuf) {
  esp_zb_zcl_read_attr_cmd_t req = {};
  req.zcl_basic_cmd.dst_addr_u.addr_short = _short;
  req.zcl_basic_cmd.dst_endpoint = _ep;
  req.zcl_basic_cmd.src_endpoint = _endpoint;
  req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  req.clusterID = cluster;
  req.manuf_specific = manuf ? 1 : 0;
  req.manuf_code = manuf;
  req.attr_number = count;
  req.attr_field = attrs;
  esp_zb_zcl_read_attr_cmd_req(&req);
}

// Byte count of the ZCL types that fit a probe value. The low three bits of
// the fixed-size type ids give the size, minus one.
static uint8_t zclSize(uint8_t type) {
  if (type == ESP_ZB_ZCL_ATTR_TYPE_BOOL) return 1;
  bool sized = (type >= 0x08 && type <= 0x0b) || (type >= 0x18 && type <= 0x1b) || (type >= 0x20 && type <= 0x23) || (type >= 0x28 && type <= 0x2b);
  if (sized) return (type & 0x07) + 1;
  if (type == ESP_ZB_ZCL_ATTR_TYPE_16BIT_ENUM) return 2;
  return 1;  // 8-bit enum, and a guess for all other types
}

void BlindEndpoint::writeAttr(uint16_t cluster, uint16_t attrId, uint8_t type, uint32_t value, uint16_t manuf) {
  esp_zb_zcl_attribute_t attr = {};
  attr.id = attrId;
  attr.data.type = (esp_zb_zcl_attr_type_t)type;
  attr.data.size = zclSize(type);
  attr.data.value = &value;  // little-endian, as on the wire
  esp_zb_zcl_write_attr_cmd_t req = {};
  req.zcl_basic_cmd.dst_addr_u.addr_short = _short;
  req.zcl_basic_cmd.dst_endpoint = _ep;
  req.zcl_basic_cmd.src_endpoint = _endpoint;
  req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  req.clusterID = cluster;
  req.manuf_specific = manuf ? 1 : 0;
  req.manuf_code = manuf;
  req.attr_number = 1;
  req.attr_field = &attr;
  esp_zb_zcl_write_attr_cmd_req(&req);
}

// Public commands: lock the stack, speak the right dialect, update intent.

bool BlindEndpoint::open() {
  if (_proto == Protocol::Unknown) return false;
  {
    ZbLock lock;
    if (_proto == Protocol::Zcl) zclCommand(_inverted ? ESP_ZB_ZCL_CMD_WINDOW_COVERING_DOWN_CLOSE : ESP_ZB_ZCL_CMD_WINDOW_COVERING_UP_OPEN, nullptr);
    else {
      uint8_t v = _inverted ? 2 : 0;
      tuyaSend(DP_CONTROL, TUYA_TYPE_ENUM, &v, 1);
    }
  }
  beginMove(+1, -1);
  return true;
}

bool BlindEndpoint::close() {
  if (_proto == Protocol::Unknown) return false;
  {
    ZbLock lock;
    if (_proto == Protocol::Zcl) zclCommand(_inverted ? ESP_ZB_ZCL_CMD_WINDOW_COVERING_UP_OPEN : ESP_ZB_ZCL_CMD_WINDOW_COVERING_DOWN_CLOSE, nullptr);
    else {
      uint8_t v = _inverted ? 0 : 2;
      tuyaSend(DP_CONTROL, TUYA_TYPE_ENUM, &v, 1);
    }
  }
  beginMove(-1, -1);
  return true;
}

bool BlindEndpoint::stop() {
  if (_proto == Protocol::Unknown) return false;
  {
    ZbLock lock;
    if (_proto == Protocol::Zcl) zclCommand(ESP_ZB_ZCL_CMD_WINDOW_COVERING_STOP, nullptr);
    else {
      uint8_t v = 1;
      tuyaSend(DP_CONTROL, TUYA_TYPE_ENUM, &v, 1);
    }
  }
  beginMove(0, -1);
  return true;
}

bool BlindEndpoint::goTo(int openPct) {
  if (_proto == Protocol::Unknown) return false;
  openPct = constrain(openPct, 0, 100);
  // Undo our own conventions to get back to the wire number.
  int raw = _inverted ? 100 - openPct : openPct;
  if (_proto == Protocol::Zcl) raw = 100 - raw;
  {
    ZbLock lock;
    if (_proto == Protocol::Zcl) {
      uint8_t v = raw;
      zclCommand(ESP_ZB_ZCL_CMD_WINDOW_COVERING_GO_TO_LIFT_PERCENTAGE, &v);
    } else {
      uint8_t v[4] = {0, 0, 0, (uint8_t)raw};
      tuyaSend(DP_GOTO, TUYA_TYPE_VALUE, v, 4);
    }
  }
  int cur = _open;
  beginMove(cur < 0 ? 0 : (openPct > cur ? +1 : openPct < cur ? -1 : 0), openPct);
  if (cur >= 0 && openPct == cur) _moving = false;
  return true;
}

void BlindEndpoint::refresh() {
  if (_proto == Protocol::Unknown) return;
  ZbLock lock;
  if (_proto == Protocol::Zcl && !_tuyaPos) {
    uint16_t attr = ATTR_LIFT_PCT;
    readAttrs(CLUSTER_COVERING, &attr, 1);
  } else {
    tuyaSend(0, 0, nullptr, 0);
  }
}

bool BlindEndpoint::probe(const Probe &p) {
  if (_proto == Protocol::Unknown) return false;
  ZbLock lock;
  switch (p.op) {
    case Probe::Op::TuyaQuery:
      logbuf::line("[probe] tuya query");
      tuyaSend(0, 0, nullptr, 0);
      break;
    case Probe::Op::TuyaWrite: {
      // Tuya numbers are big-endian. A value has 4 bytes; the other types
      // that a probe can send have 1.
      uint8_t v[4] = {(uint8_t)(p.value >> 24), (uint8_t)(p.value >> 16), (uint8_t)(p.value >> 8), (uint8_t)p.value};
      logbuf::line("[probe] tuya dp %u type %u = %lu", p.dp, p.type, (unsigned long)p.value);
      if (p.type == TUYA_TYPE_VALUE) tuyaSend(p.dp, p.type, v, 4);
      else tuyaSend(p.dp, p.type, v + 3, 1);
      break;
    }
    case Probe::Op::AttrRead: {
      uint16_t attr = p.attr;
      logbuf::line("[probe] read attr 0x%04x/0x%04x manuf 0x%04x", p.cluster, p.attr, p.manuf);
      readAttrs(p.cluster, &attr, 1, p.manuf);
      break;
    }
    case Probe::Op::AttrWrite:
      logbuf::line("[probe] write attr 0x%04x/0x%04x type 0x%02x = %lu manuf 0x%04x", p.cluster, p.attr, p.type, (unsigned long)p.value, p.manuf);
      writeAttr(p.cluster, p.attr, p.type, p.value, p.manuf);
      break;
  }
  return true;
}

State BlindEndpoint::state() const {
  return State{
    .paired = _proto != Protocol::Unknown,
    .pairing = (int32_t)(millis() - _pairingUntilMs) < 0,
    .protocol = _proto,
    .open = _open,
    .moving = _moving,
    .dir = _dir,
    .target = _target,
    .shortAddr = _short,
    .endpoint = _ep,
    .travelMs = _travelMs,
  };
}

const char *protocolName(Protocol p) { return protoName(p); }

}  // namespace blind
