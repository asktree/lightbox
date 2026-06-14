#include "wled.h"
#include "timecode_buffer.h"

// WLED 16.x self-registers usermods via the REGISTER_USERMOD macro + the
// custom_usermods build system (this .cpp is compiled). WLED 0.15.x has no
// such macro — there the usermod is registered by usermods_list.cpp instead
// (header-only), and this .cpp is simply not part of that build. Guarding the
// macro lets one source tree serve both.
#ifdef REGISTER_USERMOD
static TimecodeBufferUsermod timecode_buffer;
REGISTER_USERMOD(timecode_buffer);
#endif
