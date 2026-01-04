import { useEffect, useRef, useState } from 'react';
import { useDebugStore } from '../stores/debug';
import type { Brand } from '@lightbox/shared';

interface DebugPanelProps {
  filterDevice?: string;    // Optional: only show logs for this device
  filterDevices?: string[]; // Optional: only show logs for these devices (room filter)
  compact?: boolean;        // Compact mode for embedding in LightPane
}

export function DebugPanel({ filterDevice, filterDevices, compact }: DebugPanelProps) {
  const logs = useDebugStore((s) => s.logs);
  const clearLogs = useDebugStore((s) => s.clearLogs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Brand filter state - both ON by default
  const [enabledBrands, setEnabledBrands] = useState<Set<Brand>>(
    new Set(['hue', 'tuya', 'govee'])
  );

  const toggleBrand = (brand: Brand) => {
    setEnabledBrands((prev) => {
      const next = new Set(prev);
      if (next.has(brand)) {
        next.delete(brand);
      } else {
        next.add(brand);
      }
      return next;
    });
  };

  // Auto-scroll to top when new logs arrive (if autoScroll is enabled)
  // Since newest logs are at top, we scroll to top
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [logs, autoScroll]);

  // Handle scroll to detect if user scrolled down (away from top)
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop } = scrollRef.current;
    // Consider "at top" if within 20px of top
    const atTop = scrollTop < 20;
    setAutoScroll(atTop);
  };

  // Apply device filter first
  const deviceFilteredLogs = filterDevice
    ? logs.filter((l) => l.device === filterDevice)
    : filterDevices && filterDevices.length > 0
      ? logs.filter((l) => filterDevices.includes(l.device))
      : logs;

  // Then apply brand filter
  const filteredLogs = deviceFilteredLogs.filter((l) => enabledBrands.has(l.brand));

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };

  // Render message with colored status parenthetical
  const renderMessage = (message: string) => {
    // Match pattern like "... (✓ 123ms)" or "... (...)" or "... (✗ 123ms)"
    const match = message.match(/^(.*)(\([^)]+\))$/);
    if (!match) return message;

    const [, prefix, status] = match;
    let statusClass = 'text-zinc-500'; // default grey for waiting
    if (status.includes('✓')) {
      statusClass = 'text-green-400';
    } else if (status.includes('✗')) {
      statusClass = 'text-red-400';
    }

    return (
      <>
        {prefix}
        <span className={statusClass}>{status}</span>
      </>
    );
  };

  if (compact) {
    // Newest first, take first 50
    const displayLogs = filteredLogs.slice(0, 50);

    return (
      <div className="mt-4 border-t border-zinc-700 pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wide">Debug Log</span>
          <button
            onClick={clearLogs}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Clear
          </button>
        </div>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-24 overflow-y-auto font-mono text-[10px] space-y-1 bg-black/30 rounded p-1.5"
        >
          {displayLogs.length === 0 ? (
            <div className="text-zinc-600 italic">No messages yet</div>
          ) : (
            displayLogs.map((log, i) => (
              <div key={`${log.id}-${i}`}>
                <div className="text-zinc-600">
                  {formatTime(log.timestamp)}
                  {' '}
                  <span className={log.direction === 'out' ? 'text-blue-500' : 'text-green-500'}>
                    {log.direction === 'out' ? '→' : '←'}
                  </span>
                </div>
                <div className={log.direction === 'out' ? 'text-blue-300' : 'text-green-300'}>
                  {renderMessage(log.message)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed left-4 top-20 bottom-4 w-[480px] bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg shadow-xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-300">Debug Log</h3>
        <div className="flex items-center gap-2">
          {/* Brand filter toggles */}
          <button
            onClick={() => toggleBrand('hue')}
            className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
              enabledBrands.has('hue')
                ? 'bg-amber-900/60 text-amber-300 hover:bg-amber-900/80'
                : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
            }`}
          >
            Hue
          </button>
          <button
            onClick={() => toggleBrand('tuya')}
            className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
              enabledBrands.has('tuya')
                ? 'bg-purple-900/60 text-purple-300 hover:bg-purple-900/80'
                : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
            }`}
          >
            Tuya
          </button>
          <button
            onClick={clearLogs}
            className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-2"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-zinc-600 italic text-center py-4">Waiting for messages...</div>
        ) : (
          filteredLogs.map((log, i) => (
            <div key={`${log.id}-${i}`}>
              <div className="text-[10px] text-zinc-600">
                {formatTime(log.timestamp)}
                {' '}
                <span className={log.direction === 'out' ? 'text-blue-500' : 'text-green-500'}>
                  {log.direction === 'out' ? '→' : '←'}
                </span>
                {' '}
                <span className="text-zinc-500">[{log.device}]</span>
              </div>
              <div
                className={
                  log.direction === 'out' ? 'text-blue-300' : 'text-green-300'
                }
              >
                {renderMessage(log.message)}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Legend */}
      <div className="p-2 border-t border-zinc-800 flex gap-4 text-[10px]">
        <span className="text-blue-400">→ sent</span>
        <span className="text-green-400">← received</span>
      </div>
    </div>
  );
}
