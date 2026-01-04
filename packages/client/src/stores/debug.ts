import { create } from 'zustand';
import type { DebugLogEntry, DeviceDiagnostics } from '@lightbox/shared';

interface DebugState {
  logs: DebugLogEntry[];
  diagnostics: Map<string, DeviceDiagnostics>;
  isOpen: boolean;

  addLog: (entry: DebugLogEntry) => void;
  updateLog: (id: string, message: string) => void;
  syncDiagnostics: (diags: DeviceDiagnostics[]) => void;
  setOpen: (open: boolean) => void;
  clearLogs: () => void;
}

const MAX_LOGS = 200;

export const useDebugStore = create<DebugState>((set) => ({
  logs: [],
  diagnostics: new Map(),
  isOpen: true,

  addLog: (entry) =>
    set((state) => {
      // Dedupe by ID (React Strict Mode can cause duplicate WebSocket connections)
      if (state.logs.some((l) => l.id === entry.id)) {
        return state;
      }
      const logs = [entry, ...state.logs].slice(0, MAX_LOGS);
      return { logs };
    }),

  updateLog: (id, message) =>
    set((state) => {
      const logs = state.logs.map((log) =>
        log.id === id ? { ...log, message } : log
      );
      return { logs };
    }),

  syncDiagnostics: (diags) =>
    set(() => {
      const diagnostics = new Map<string, DeviceDiagnostics>();
      for (const d of diags) {
        diagnostics.set(d.id, d);
      }
      return { diagnostics };
    }),

  setOpen: (open) => set({ isOpen: open }),

  clearLogs: () => set({ logs: [] }),
}));
