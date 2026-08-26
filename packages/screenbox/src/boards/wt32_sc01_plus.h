// Board definition for the Wireless-Tag WT32-SC01 Plus (ZX3D50CE08S, PanelLan SC01_PLUS).
// ESP32-S3, 16 MB flash / 8 MB OPI PSRAM, 3.5" 320x480 ST7796 on an 8-bit 8080 bus,
// FT6336 touch (FT5x06-compatible). Pin map from the PanelLan Arduino library.
#pragma once
#include <LovyanGFX.hpp>

namespace board {

constexpr int PHYS_W = 320, PHYS_H = 480;   // the panel itself
#if defined(SCREENBOX_LOWRES)
// Experiment: render at half resolution and pixel-double on push (2x2 pseudo pixels)
constexpr int PIXEL_SCALE = 2;
constexpr int LCD_W = PHYS_W / 2;
constexpr int LCD_H = PHYS_H / 2;
constexpr int WHEEL_R = 70;         // labyrinth field is 2*WHEEL_R (src/labyrinth_140.h)
#define SCREENBOX_LAB_HEADER "labyrinth_140.h"
constexpr int TEXT_SCALE = 1;
inline const lgfx::IFont* uiFont() { return &fonts::TomThumb; }   // 3x5 -> 6x10 physical
#else
constexpr int PIXEL_SCALE = 1;
constexpr int LCD_W = PHYS_W;
constexpr int LCD_H = PHYS_H;
constexpr int WHEEL_R = 140;        // labyrinth field is 2*WHEEL_R (src/labyrinth_280.h)
#define SCREENBOX_LAB_HEADER "labyrinth_280.h"
constexpr int TEXT_SCALE = 1;
inline const lgfx::IFont* uiFont() { return &fonts::DejaVu12; }
#endif

constexpr int LCD_BL  = 45;
constexpr int LCD_RST = 4;          // shared with touch reset
constexpr int LCD_RS  = 0;
constexpr int LCD_WR  = 47;
constexpr int LCD_TE  = 48;
constexpr int LCD_D[8] = {9, 46, 3, 8, 18, 17, 16, 15};

constexpr int TP_SDA = 6;
constexpr int TP_SCL = 5;
constexpr int TP_INT = 7;

constexpr int EXT_IO[6] = {10, 11, 12, 13, 14, 21};

class Panel_ST7796_SC01P : public lgfx::Panel_ST7796 {
protected:
  const uint8_t* getInitCommands(uint8_t listno) const override {
    static constexpr uint8_t list0[] = {
      0x11, 0 + CMD_INIT_DELAY, 120,
      0x36, 1, 0x48,
      0x3A, 1, 0x55,
      0xF0, 1, 0xC3,
      0xF0, 1, 0x96,
      0xB4, 1, 0x01,
      0xB5, 1, 0x1E,
      0xB6, 3, 0x80, 0x22, 0x3B,
      0xB7, 1, 0xC6,
      0xB9, 2, 0x02, 0xE0,
      0xC0, 2, 0x80, 0x16,
      0xC1, 1, 0x19,
      0xC2, 1, 0xA7,
      0xC5, 1, 0x16,
      0xE8, 8, 0x40, 0x8A, 0x00, 0x00, 0x29, 0x19, 0xA5, 0x33,
      0xE0, 14, 0xF0, 0x07, 0x0D, 0x04, 0x05, 0x14, 0x36, 0x54, 0x4C, 0x38, 0x13, 0x14, 0x2E, 0x34,
      0xE1, 14, 0xF0, 0x10, 0x14, 0x0E, 0x0C, 0x08, 0x35, 0x44, 0x4C, 0x26, 0x10, 0x12, 0x2C, 0x32,
      0xF0, 1, 0x3C,
      0xF0, 1 + CMD_INIT_DELAY, 0x69, 120,
      0x29, 0,
      0x21, 0,
      0xFF, 0xFF,
    };
    return listno == 0 ? list0 : nullptr;
  }
};

class Display : public lgfx::LGFX_Device {
  Panel_ST7796_SC01P  _panel;
  lgfx::Bus_Parallel8 _bus;
  lgfx::Light_PWM     _light;
  lgfx::Touch_FT5x06  _touch;

public:
  Display() {
    {
      auto cfg = _bus.config();
      cfg.port       = 0;
      cfg.freq_write = 40000000;
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
      cfg.memory_width  = PHYS_W;  cfg.memory_height = PHYS_H;
      cfg.panel_width   = PHYS_W;  cfg.panel_height  = PHYS_H;
      cfg.offset_x = 0;  cfg.offset_y = 0;
      cfg.offset_rotation  = 2;
      cfg.dummy_read_pixel = 8;
      cfg.dummy_read_bits  = 1;
      cfg.readable   = false;
      cfg.invert     = true;
      cfg.rgb_order  = false;
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
      cfg.x_min = 0; cfg.x_max = PHYS_W;
      cfg.y_min = 0; cfg.y_max = PHYS_H;
      cfg.bus_shared      = false;
      cfg.offset_rotation = 0;
      cfg.i2c_port = 1;
      cfg.pin_sda  = TP_SDA;
      cfg.pin_scl  = TP_SCL;
      cfg.pin_int  = TP_INT;
      cfg.pin_rst  = -1;
      cfg.freq     = 400000;
      _touch.config(cfg);
      _panel.setTouch(&_touch);
    }
    setPanel(&_panel);
  }
};

}  // namespace board
