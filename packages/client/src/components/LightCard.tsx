import type { Light } from '@lightbox/shared';
import { useLightsStore } from '../stores/lights';

interface Props {
  light: Light;
}

function hsvToHex(h: number, s: number, v: number = 100): string {
  h = h / 360;
  s = s / 100;
  v = v / 100;

  let r = 0, g = 0, b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }

  const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function kelvinToHex(kelvin: number): string {
  const temp = kelvin / 100;
  let r: number, g: number, b: number;

  if (temp <= 66) {
    r = 255;
    g = temp <= 0 ? 0 : 99.4708025861 * Math.log(temp) - 161.1195681661;
    b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    b = 255;
  }

  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function LightCard({ light }: Props) {
  const setLightState = useLightsStore((s) => s.setLightState);
  const startControlling = useLightsStore((s) => s.startControlling);
  const stopControlling = useLightsStore((s) => s.stopControlling);
  const bridgeState = useLightsStore((s) => s.bridgeStates.get(light.id));
  const isControlled = useLightsStore((s) => s.controlledLights.has(light.id));

  const { state, capabilities } = light;

  const hasColor = capabilities.includes('color');
  const hasBrightness = capabilities.includes('brightness');
  const hasTemperature = capabilities.includes('temperature');

  // Determine the display color
  let displayColor = '#fbbf24';
  if (state.color && hasColor) {
    displayColor = hsvToHex(state.color.h, state.color.s);
  } else if (state.temperature && hasTemperature) {
    displayColor = kelvinToHex(state.temperature);
  }

  const opacity = state.on ? (state.brightness ?? 100) / 100 : 0.2;

  return (
    <div
      className={`relative rounded-2xl p-4 ${isControlled ? '' : 'transition-all'} ${
        state.on ? 'bg-zinc-800' : 'bg-zinc-900'
      } ${!light.reachable ? 'opacity-50' : ''}`}
    >
      {/* Color indicator */}
      <div
        className={`absolute top-3 right-3 w-4 h-4 rounded-full ${isControlled ? '' : 'transition-all'}`}
        style={{
          backgroundColor: displayColor,
          opacity: state.on ? opacity : 0.3,
          boxShadow: state.on ? `0 0 12px ${displayColor}` : 'none',
        }}
      />

      {/* Light name */}
      <h3 className="font-medium text-sm mb-3 pr-6">{light.name}</h3>

      {/* Power toggle */}
      <button
        onClick={() => setLightState(light.id, { on: !state.on })}
        className={`w-full py-2 rounded-lg text-sm font-medium transition-all ${
          state.on
            ? 'bg-white text-black'
            : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
        }`}
        disabled={!light.reachable}
      >
        {state.on ? 'On' : 'Off'}
      </button>

      {/* Brightness slider with phantom */}
      {hasBrightness && state.on && (
        <div className="mt-3 relative">
          {/* Phantom slider (bridge state) */}
          {bridgeState && bridgeState.brightness !== undefined && (
            <div
              className="absolute top-0 left-0 h-2 bg-zinc-500 rounded-lg pointer-events-none opacity-50"
              style={{ width: `${bridgeState.brightness}%` }}
            />
          )}
          <input
            type="range"
            min="1"
            max="100"
            value={state.brightness ?? 100}
            onMouseDown={() => startControlling(light.id)}
            onMouseUp={() => stopControlling(light.id)}
            onMouseLeave={() => isControlled && stopControlling(light.id)}
            onTouchStart={() => startControlling(light.id)}
            onTouchEnd={() => stopControlling(light.id)}
            onChange={(e) =>
              setLightState(light.id, { brightness: parseInt(e.target.value) })
            }
            className="relative w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-white"
          />
        </div>
      )}

      {/* Quick color buttons */}
      {hasColor && state.on && (
        <div className="mt-3 flex gap-1">
          {[
            { h: 0, s: 100, label: 'Red' },
            { h: 30, s: 100, label: 'Orange' },
            { h: 60, s: 100, label: 'Yellow' },
            { h: 120, s: 100, label: 'Green' },
            { h: 200, s: 100, label: 'Blue' },
            { h: 280, s: 100, label: 'Purple' },
            { h: 320, s: 100, label: 'Pink' },
          ].map(({ h, s, label }) => (
            <button
              key={label}
              onClick={() => setLightState(light.id, { color: { h, s } })}
              className="w-6 h-6 rounded-full border-2 border-zinc-600 hover:border-white transition-all"
              style={{ backgroundColor: hsvToHex(h, s) }}
              title={label}
            />
          ))}
        </div>
      )}

      {/* Temperature presets */}
      {hasTemperature && !hasColor && state.on && (
        <div className="mt-3 flex gap-1">
          {[
            { temp: 2200, label: 'Warm' },
            { temp: 3500, label: 'Neutral' },
            { temp: 5000, label: 'Cool' },
          ].map(({ temp, label }) => (
            <button
              key={temp}
              onClick={() => setLightState(light.id, { temperature: temp })}
              className="flex-1 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600 transition-all"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {!light.reachable && (
        <p className="text-xs text-zinc-500 mt-2">Unreachable</p>
      )}
    </div>
  );
}
