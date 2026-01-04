import { useEffect, useRef } from 'react';
import type { WSMessage } from '@lightbox/shared';
import { useLightsStore } from '../stores/lights';

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const { setConnected, syncLights, updateLight } = useLightsStore();

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
        }
      };
    }

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [setConnected, syncLights, updateLight]);
}
