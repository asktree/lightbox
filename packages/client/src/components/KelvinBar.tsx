import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { Light } from '@lightbox/shared';
import { useLightsStore } from '../stores/lights';

// 1D warm↔cool white zone. Temperature-capable lights in CT mode live here
// as pins; dragging a pin off the bar into the wheel switches the light
// back to color mode (and the wheel does the reverse — see ColorWheel's
// kelvinBarRef handling).

// 1700K floor: CT hardware stops at 2000K; below that the server emulates
// the blackbody chromaticity with the color engine.
export const KELVIN_MIN = 1700;
export const KELVIN_MAX = 6500;

export function xToKelvin(x: number, rect: DOMRect): number {
  const frac = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  return Math.round(KELVIN_MIN + frac * (KELVIN_MAX - KELVIN_MIN));
}

// Tanner Helland kelvin→RGB approximation, clamped to our range.
export function kelvinToHex(k: number): string {
  const t = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, k)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

interface Props {
  lights: Light[]; // temperature-capable and on; this component picks the CT-mode ones
  width: number;
  zoneRef: React.MutableRefObject<HTMLDivElement | null>;   // attached to our container (wheel drags drop-test against it)
  wheelRef: React.MutableRefObject<HTMLDivElement | null>;  // wheel container (we drop-test against it)
  selectedLightId?: string | null;
  onLightSelect?: (lightId: string | null) => void;
}

const BAR_HEIGHT = 36;
const PIN_RADIUS = 14;

export function KelvinBar({ lights, width, zoneRef, wheelRef, selectedLightId, onLightSelect }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const setLightState = useLightsStore((s) => s.setLightState);
  const startControlling = useLightsStore((s) => s.startControlling);
  const stopControlling = useLightsStore((s) => s.stopControlling);
  const lightsById = useRef(lights);
  lightsById.current = lights;

  // CT-mode residents of the bar. Lights in color mode stay on the wheel.
  const barLights = lights.filter((l) => l.state.on && l.state.temperature !== undefined);

  const gradient = useMemo(() => {
    const stops = Array.from({ length: 11 }, (_, i) => {
      const k = KELVIN_MIN + (i / 10) * (KELVIN_MAX - KELVIN_MIN);
      return `${kelvinToHex(k)} ${i * 10}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging || !zoneRef.current) return;

    // Dropped into the wheel circle → back to color mode.
    const wheel = wheelRef.current;
    const light = lightsById.current.find((l) => l.id === dragging);
    if (wheel && light?.capabilities.includes('color')) {
      const wr = wheel.getBoundingClientRect();
      const radius = wr.width / 2;
      const dx = e.clientX - (wr.left + radius);
      const dy = e.clientY - (wr.top + radius);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        const h = ((angle % 360) + 360) % 360;
        const s = Math.min(100, (dist / radius) * 100);
        setLightState(dragging, { color: { h: Math.round(h), s: Math.round(s) } }, 50);
        return;
      }
    }

    setLightState(dragging, { temperature: xToKelvin(e.clientX, zoneRef.current.getBoundingClientRect()) }, 50);
  }, [dragging, zoneRef, wheelRef, setLightState]);

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      stopControlling(dragging);
      setDragging(null);
    }
  }, [dragging, stopControlling]);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  return (
    <div
      ref={zoneRef}
      className="relative select-none rounded-full"
      style={{ width, height: BAR_HEIGHT, background: gradient }}
    >
      {/* Kelvin ticks */}
      {[2700, 4000, 5500].map((k) => (
        <div
          key={k}
          className="absolute top-full mt-0.5 -translate-x-1/2 text-[9px] text-zinc-500 pointer-events-none"
          style={{ left: `${((k - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN)) * 100}%` }}
        >{k}K</div>
      ))}

      {barLights.map((light) => {
        const k = light.state.temperature ?? 3000;
        const frac = (Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, k)) - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN);
        const isDragging = dragging === light.id;
        return (
          <div
            key={light.id}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startControlling(light.id);
              setDragging(light.id);
              onLightSelect?.(light.id);
            }}
            className={`absolute flex items-center justify-center cursor-grab active:cursor-grabbing ${isDragging ? 'z-20' : 'z-10'}`}
            style={{
              left: 0,
              top: BAR_HEIGHT / 2 - PIN_RADIUS,
              width: PIN_RADIUS * 2,
              height: PIN_RADIUS * 2,
              transform: `translateX(${frac * width - PIN_RADIUS}px)`,
              transition: isDragging ? 'none' : 'transform 100ms ease-out',
              opacity: light.reachable ? 1 : 0.5,
            }}
          >
            <motion.div
              className="w-full h-full rounded-full border-white"
              animate={{ borderWidth: selectedLightId === light.id ? 5 : 3 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              style={{ backgroundColor: kelvinToHex(k), boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}
            />
            {!isDragging && (
              <div
                className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] text-white whitespace-nowrap pointer-events-none z-30"
                style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5), 0 0 6px rgba(0,0,0,0.3)' }}
              >
                {light.name}
              </div>
            )}
          </div>
        );
      })}

      {barLights.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-900/60 pointer-events-none">
          drag a light here for warm/cool white
        </div>
      )}
    </div>
  );
}
