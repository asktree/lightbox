"""Actual audio output latency via macOS Core Audio.

Total output latency, in frames, at the default output device:
    kAudioDevicePropertyLatency        (device-inherent hardware delay)
  + kAudioDevicePropertySafetyOffset   (safety offset to avoid underrun)
  + kAudioDevicePropertyBufferFrameSize (the HAL IO buffer)
  + kAudioStreamPropertyLatency        (stream-inherent delay, e.g. AirPlay's 2s buffer)

Divide by kAudioDevicePropertyNominalSampleRate → seconds → ms.

This is what Apple reports as the canonical end-to-end output latency — same
number AUHosts and audio apps consult when compensating plugin delay. For an
AirPlay target it reads ~88200 frames at 44.1kHz (~2000ms), for built-in
speakers ~1400 frames at 48kHz (~30ms). Implemented via ctypes to avoid a
PyObjC dependency.
"""
from __future__ import annotations

import ctypes
from ctypes import (
    c_uint32, c_int32, c_double, c_void_p, sizeof, byref, POINTER, Structure, create_string_buffer,
)
from typing import Optional


_FW = ctypes.CDLL('/System/Library/Frameworks/CoreAudio.framework/CoreAudio')


class _Addr(Structure):
    _fields_ = [
        ('mSelector', c_uint32),
        ('mScope',    c_uint32),
        ('mElement',  c_uint32),
    ]


_FW.AudioObjectGetPropertyData.restype = c_int32
_FW.AudioObjectGetPropertyData.argtypes = [
    c_uint32, POINTER(_Addr), c_uint32, c_void_p, POINTER(c_uint32), c_void_p,
]
_FW.AudioObjectGetPropertyDataSize.restype = c_int32
_FW.AudioObjectGetPropertyDataSize.argtypes = [
    c_uint32, POINTER(_Addr), c_uint32, c_void_p, POINTER(c_uint32),
]


def _fourcc(s: str) -> int:
    return int.from_bytes(s.encode('ascii'), 'big')

K_SYSTEM  = 1
K_DEF_OUT = _fourcc('dOut')   # kAudioHardwarePropertyDefaultOutputDevice
K_SCOPE_GLOBAL = _fourcc('glob')
K_SCOPE_OUTPUT = _fourcc('outp')
K_ELEMENT_MAIN = 0
K_LATENCY       = _fourcc('ltnc')  # kAudioDevicePropertyLatency
K_SAFETY        = _fourcc('saft')  # kAudioDevicePropertySafetyOffset
K_BUFFER_FRAMES = _fourcc('fsiz')  # kAudioDevicePropertyBufferFrameSize
K_SAMPLE_RATE   = _fourcc('nsrt')  # kAudioDevicePropertyNominalSampleRate
K_STREAMS       = _fourcc('stm#')  # kAudioDevicePropertyStreams
K_STREAM_LATENC = _fourcc('ltnc')  # kAudioStreamPropertyLatency (same fourcc, different object)
K_NAME_CFSTR    = _fourcc('lnam')  # kAudioObjectPropertyName (returns CFStringRef)


def _get_u32(obj_id: int, selector: int, scope: int) -> Optional[int]:
    addr = _Addr(selector, scope, K_ELEMENT_MAIN)
    val = c_uint32(0)
    size = c_uint32(sizeof(val))
    err = _FW.AudioObjectGetPropertyData(obj_id, byref(addr), 0, None, byref(size), byref(val))
    return val.value if err == 0 else None


def _get_f64(obj_id: int, selector: int, scope: int) -> Optional[float]:
    addr = _Addr(selector, scope, K_ELEMENT_MAIN)
    val = c_double(0)
    size = c_uint32(sizeof(val))
    err = _FW.AudioObjectGetPropertyData(obj_id, byref(addr), 0, None, byref(size), byref(val))
    return val.value if err == 0 else None


def _get_streams(device_id: int) -> list[int]:
    addr = _Addr(K_STREAMS, K_SCOPE_OUTPUT, K_ELEMENT_MAIN)
    size = c_uint32(0)
    if _FW.AudioObjectGetPropertyDataSize(device_id, byref(addr), 0, None, byref(size)) != 0:
        return []
    n = size.value // sizeof(c_uint32)
    if n == 0:
        return []
    ArrT = c_uint32 * n
    arr = ArrT()
    sz = c_uint32(size.value)
    if _FW.AudioObjectGetPropertyData(device_id, byref(addr), 0, None, byref(sz), byref(arr)) != 0:
        return []
    return list(arr)


def _device_name(device_id: int) -> Optional[str]:
    """Read device name via Core Foundation CFString. Uses CFStringGetCString."""
    addr = _Addr(K_NAME_CFSTR, K_SCOPE_GLOBAL, K_ELEMENT_MAIN)
    cfstr = c_void_p(None)
    size = c_uint32(sizeof(cfstr))
    if _FW.AudioObjectGetPropertyData(device_id, byref(addr), 0, None, byref(size), byref(cfstr)) != 0 or not cfstr.value:
        return None
    try:
        cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        cf.CFStringGetCString.restype = ctypes.c_bool
        cf.CFStringGetCString.argtypes = [c_void_p, c_void_p, c_uint32, c_uint32]
        cf.CFRelease.argtypes = [c_void_p]
        buf = create_string_buffer(256)
        cf.CFStringGetCString(cfstr.value, buf, 256, 0x08000100)  # kCFStringEncodingUTF8
        name = buf.value.decode('utf-8', errors='replace') or None
        cf.CFRelease(cfstr.value)
        return name
    except Exception:
        return None


def get_output_latency_ms() -> tuple[Optional[int], Optional[str]]:
    """Returns (total_latency_ms, device_name) or (None, None) on failure."""
    # Default output device
    addr = _Addr(K_DEF_OUT, K_SCOPE_GLOBAL, K_ELEMENT_MAIN)
    did = c_uint32(0)
    size = c_uint32(sizeof(did))
    if _FW.AudioObjectGetPropertyData(K_SYSTEM, byref(addr), 0, None, byref(size), byref(did)) != 0:
        return (None, None)
    device_id = did.value
    if device_id == 0:
        return (None, None)

    device_latency = _get_u32(device_id, K_LATENCY, K_SCOPE_OUTPUT) or 0
    safety_offset  = _get_u32(device_id, K_SAFETY, K_SCOPE_OUTPUT) or 0
    buffer_frames  = _get_u32(device_id, K_BUFFER_FRAMES, K_SCOPE_OUTPUT) or 0
    sample_rate    = _get_f64(device_id, K_SAMPLE_RATE, K_SCOPE_OUTPUT) or 48000.0

    # Sum of stream-level latencies on the output scope.
    stream_latency = 0
    for s in _get_streams(device_id):
        stream_latency += _get_u32(s, K_STREAM_LATENC, K_SCOPE_OUTPUT) or 0

    total_frames = device_latency + safety_offset + buffer_frames + stream_latency
    ms = int(round(total_frames / sample_rate * 1000))
    return (ms, _device_name(device_id))


if __name__ == "__main__":
    import json, sys
    ms, name = get_output_latency_ms()
    if "--json" in sys.argv:
        print(json.dumps({"output_latency_ms": ms, "output_device_name": name}))
    else:
        print(f"latency: {ms} ms  (device: {name!r})")
