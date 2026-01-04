import { useEffect, useRef } from 'react';
import type { WSMessage } from '@lightbox/shared';
import { useLightsStore } from '../stores/lights';
import { useDebugStore } from '../stores/debug';
import { usePalettesStore } from '../stores/palettes';

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const { setConnected, syncLights, updateLight } = useLightsStore();
  const { addLog, updateLog, syncDiagnostics } = useDebugStore();
  const {
    syncRoomStates,
    updateRoomState,
    updatePalettePositions,
    updateLightPosition,
  } = usePalettesStore();

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        setConnected(true);
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        setConnected(false);
        setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        ws.close();
      };

      ws.onmessage = (event) => {
        const msg: WSMessage = JSON.parse(event.data);

        switch (msg.type) {
          case 'lights_sync':
            syncLights(msg.lights);
            break;
          case 'light_update':
            updateLight(msg.light);
            break;
          case 'debug_log':
            addLog(msg.entry);
            break;
          case 'debug_log_update':
            updateLog(msg.id, msg.message);
            break;
          case 'diagnostics_sync':
            syncDiagnostics(msg.diagnostics);
            break;
          // Room/palette state messages
          case 'room_states_sync':
            syncRoomStates(msg.roomStates);
            break;
          case 'room_state':
            updateRoomState(msg.roomId, msg.activePaletteId, msg.isPlaying, msg.secondsPerNode);
            break;
          case 'palette_positions':
            updatePalettePositions(msg.roomId, msg.paletteId, msg.positions);
            break;
          case 'position_update':
            updateLightPosition(msg.roomId, msg.paletteId, msg.lightId, msg.position);
            break;
        }
      };
    }

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [
    setConnected,
    syncLights,
    updateLight,
    addLog,
    updateLog,
    syncDiagnostics,
    syncRoomStates,
    updateRoomState,
    updatePalettePositions,
    updateLightPosition,
  ]);
}
