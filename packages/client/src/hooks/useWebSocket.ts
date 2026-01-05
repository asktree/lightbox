import { useEffect, useRef } from 'react';
import type { WSMessage } from '@lightbox/shared';
import { useLightsStore } from '../stores/lights';
import { useDebugStore } from '../stores/debug';
import { usePalettesStore } from '../stores/palettes';

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    function connect() {
      // Clear any pending reconnect
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        useLightsStore.getState().setConnected(true);
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        useLightsStore.getState().setConnected(false);
        reconnectTimeoutRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        ws.close();
      };

      ws.onmessage = (event) => {
        const msg: WSMessage = JSON.parse(event.data);

        // Access store actions directly to avoid stale closures
        const lightsStore = useLightsStore.getState();
        const debugStore = useDebugStore.getState();
        const palettesStore = usePalettesStore.getState();

        switch (msg.type) {
          case 'lights_sync':
            lightsStore.syncLights(msg.lights);
            break;
          case 'light_update':
            lightsStore.updateLight(msg.light);
            break;
          case 'debug_log':
            debugStore.addLog(msg.entry);
            break;
          case 'debug_log_update':
            debugStore.updateLog(msg.id, msg.message);
            break;
          case 'diagnostics_sync':
            debugStore.syncDiagnostics(msg.diagnostics);
            break;
          // Room/palette state messages
          case 'room_states_sync':
            palettesStore.syncRoomStates(msg.roomStates);
            break;
          case 'room_state':
            palettesStore.updateRoomState(msg.roomId, msg.activePaletteId, msg.isPlaying, msg.secondsPerNode);
            break;
          case 'palette_positions':
            palettesStore.updatePalettePositions(msg.roomId, msg.paletteId, msg.positions);
            break;
          case 'position_update':
            palettesStore.updateLightPosition(msg.roomId, msg.paletteId, msg.lightId, msg.position);
            break;
        }
      };
    }

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, []); // Empty deps - only run once on mount
}
