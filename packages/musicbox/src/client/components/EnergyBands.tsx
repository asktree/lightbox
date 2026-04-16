interface Props {
  bands: {
    subBass: number;
    bass: number;
    lowMid: number;
    mid: number;
    highMid: number;
    high: number;
  };
}

const BAND_CONFIG = [
  { key: 'subBass', label: 'Sub', color: 'bg-red-500' },
  { key: 'bass', label: 'Bass', color: 'bg-orange-500' },
  { key: 'lowMid', label: 'Low', color: 'bg-yellow-500' },
  { key: 'mid', label: 'Mid', color: 'bg-green-500' },
  { key: 'highMid', label: 'High', color: 'bg-cyan-500' },
  { key: 'high', label: 'Air', color: 'bg-blue-500' },
] as const;

export function EnergyBands({ bands }: Props) {
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-4 py-2">
      {BAND_CONFIG.map(({ key, label, color }) => (
        <div key={key} className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 w-8 text-right font-mono uppercase">{label}</span>
          <div className="flex-1 h-3 bg-zinc-800 rounded-sm overflow-hidden">
            <div
              className={`h-full ${color} rounded-sm`}
              style={{ width: `${bands[key] * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
