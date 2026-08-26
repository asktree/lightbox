// Board definition for the Wireless-Tag WT32S3-28S PRO (ZX2D80CE02S).
// Pin map cross-checked against the official datasheet (docs/) and
// Wireless-Tag's PanelLan Arduino library (SC05_X board).
#pragma once
#include <LovyanGFX.hpp>

namespace board {

constexpr int LCD_W = 240;
constexpr int LCD_H = 320;
constexpr int WHEEL_R = 104;        // labyrinth field is 2*WHEEL_R (src/labyrinth_208.h)
#define SCREENBOX_LAB_HEADER "labyrinth_208.h"
constexpr int PIXEL_SCALE = 1;
constexpr int TEXT_SCALE = 1;
inline const lgfx::IFont* uiFont() { return &fonts::Font0; }

// --- LCD: ST7789 on the ESP32-S3 LCD_CAM 8-bit 8080 bus ---------------------
constexpr int LCD_BL  = 47;   // backlight PWM, active high
constexpr int LCD_RST = 3;    // shared with touch reset
constexpr int LCD_RS  = 18;   // data/command
constexpr int LCD_WR  = 17;   // write strobe
constexpr int LCD_TE  = 38;   // tearing-effect sync (unused here)
constexpr int LCD_D[8] = {16, 40, 15, 7, 41, 42, 2, 1};

// --- Touch: FT5x06-compatible over I2C --------------------------------------
constexpr int TP_SDA = 8;
constexpr int TP_SCL = 9;
constexpr int TP_INT = 48;

// --- Other -------------------------------------------------------------------
constexpr int RS485_RXD = 4, RS485_RTS = 5, RS485_TXD = 6;
constexpr int EXT_IO[6] = {10, 11, 12, 13, 14, 21};   // 8-pin expansion header

// The panel needs a vendor-specific ST7789 init sequence (from PanelLan).
class Panel_ST7789_WT28 : public lgfx::Panel_ST7789 {
protected:
  const uint8_t* getInitCommands(uint8_t listno) const override {
    static constexpr uint8_t list0[] = {
      0x11, 0 + CMD_INIT_DELAY, 120,   // sleep out
      0x36, 1, 0x00,
      0x3A, 1, 0x05,                   // 16-bit colour
      0xB2, 5, 0x0C, 0x0C, 0x00, 0x33, 0x33,
      0xB7, 1, 0x46,
      0xBB, 1, 0x1B,
      0xC0, 1, 0x2C,
      0xC2, 1, 0x01,
      0xC3, 1, 0x0F,
      0xC4, 1, 0x20,
      0xC6, 1, 0x0F,
      0xD0, 2, 0xA4, 0xA1,
      0xD6, 1, 0xA1,
      0xE0, 14, 0xF0, 0x00, 0x06, 0x04, 0x05, 0x05, 0x31, 0x44, 0x48, 0x36, 0x12, 0x12, 0x2B, 0x34,
      0xE1, 14, 0xF0, 0x0B, 0x0F, 0x0F, 0x0D, 0x26, 0x31, 0x43, 0x47, 0x38, 0x14, 0x14, 0x2C, 0x32,
      0x21, 0,                         // inversion on (IPS)
      0x29, 0,                         // display on
      0x2C, 0,
      0xFF, 0xFF,
    };
    return listno == 0 ? list0 : nullptr;
  }
};

class Display : public lgfx::LGFX_Device {
  Panel_ST7789_WT28   _panel;
  lgfx::Bus_Parallel8 _bus;
  lgfx::Light_PWM     _light;
  lgfx::Touch_FT5x06  _touch;

public:
  Display() {
    {
      auto cfg = _bus.config();
      cfg.port       = 0;
      cfg.freq_write = 20000000;
      cfg.pin_wr = LCD_WR;
      cfg.pin_rd = -1;
      cfg.pin_rs = LCD_RS;
      cfg.pin_d0 = LCD_D[0]; cfg.pin_d1 = LCD_D[1];
      cfg.pin_d2 = LCD_D[2]; cfg.pin_d3 = LCD_D[3];
      cfg.pin_d4 = LCD_D[4]; cfg.pin_d5 = LCD_D[5];
      cfg.pin_d6 = LCD_D[6]; cfg.pin_d7 = LCD_D[7];
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs   = -1;
      cfg.pin_rst  = LCD_RST;
      cfg.pin_busy = -1;
      cfg.memory_width  = LCD_W;  cfg.memory_height = LCD_H;
      cfg.panel_width   = LCD_W;  cfg.panel_height  = LCD_H;
      cfg.offset_x = 0;  cfg.offset_y = 0;
      cfg.offset_rotation  = 2;
      cfg.dummy_read_pixel = 8;
      cfg.dummy_read_bits  = 1;
      cfg.readable   = false;
      cfg.invert     = true;
      cfg.rgb_order  = true;
      cfg.dlen_16bit = false;
      cfg.bus_shared = false;
      _panel.config(cfg);
    }
    {
      auto cfg = _light.config();
      cfg.pin_bl      = LCD_BL;
      cfg.invert      = false;
      cfg.freq        = 21111;
      cfg.pwm_channel = 7;
      _light.config(cfg);
      _panel.setLight(&_light);
    }
    {
      auto cfg = _touch.config();
      cfg.x_min = 0; cfg.x_max = LCD_W;
      cfg.y_min = 0; cfg.y_max = LCD_H;
      cfg.bus_shared      = false;
      cfg.offset_rotation = 0;
      cfg.i2c_port = 1;
      cfg.pin_sda  = TP_SDA;
      cfg.pin_scl  = TP_SCL;
      cfg.pin_int  = TP_INT;
      cfg.pin_rst  = -1;      // shares the LCD reset line
      cfg.freq     = 400000;
      _touch.config(cfg);
      _panel.setTouch(&_touch);
    }
    setPanel(&_panel);
  }
};

}  // namespace board
