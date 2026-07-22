// Wire types for the two backends musicbox2 reads.
// Autopilot state: written by scraper/autopilot.py, relayed by lightbox 3001.
// Stem-sync status: lightbox 3001 services/stem-sync.ts.

export const STEMS = ['drums', 'bass', 'vocals', 'other'] as const;
export type Stem = (typeof STEMS)[number];

export const STEM_COLOR: Record<Stem, string> = {
  drums: '#f59e0b',
  bass: '#a78bfa',
  vocals: '#f472b6',
  other: '#34d399',
};

export interface IngestStage {
  started_at?: number;
  secs?: number;
}

export interface IngestProgress {
  stage?: string; // metadata | download | demucs | done | failed
  stages?: Record<string, IngestStage>;
  error?: string | null;
  updated_at?: number;
}

export type TrackStatus = 'ready' | 'ingesting' | 'pending' | 'failed' | 'unknown';

export interface QueueItem {
  id: string | null;
  name: string;
  artists: string[];
  album?: string;
  duration_s?: number;
  art_url?: string | null;
  status: TrackStatus;
}

export interface HistoryItem {
  id: string;
  name?: string | null;
  artists?: string[];
  ok: boolean;
  rc: number;
  secs: number;
  at: number;
}

export interface AutopilotState {
  running?: boolean;
  pid?: number;
  track_id?: string | null;
  track_name?: string;
  artists?: string[];
  album?: string;
  art_url?: string | null;
  duration_s?: number | null;
  track_status?: TrackStatus;
  playing?: boolean;
  position_s?: number;
  drift_ms?: number | null;
  output_latency_ms?: number | null;
  output_device_name?: string | null;
  ingesting?: string[];
  ingest_started?: Record<string, number>;
  ingest_progress?: Record<string, IngestProgress | null>;
  ingest_history?: HistoryItem[];
  queue?: QueueItem[];
  auto_ingest?: boolean;
  prefetch?: number;
  blacklist?: string[];
  last_error?: string | null;
  updated_at?: number;
  stale?: boolean;
  exit_reason?: 'auth' | 'stopped' | 'crash';
  // Server-side age-corrected playhead (lightbox relay adds it); also set
  // directly by the synthesized local-player state.
  position_live?: number;
}

export type PlayheadSource = 'spotify' | 'local';

export interface StemBinding {
  rid: string;
  stems: Stem[];
  minLevel?: number;
  maxLevel?: number;
  colorMode?: 'palette' | 'chroma';
  hueStart?: number;
  hueEnd?: number;
  hueDir?: 'up' | 'down';
}

export interface StemSyncStatus {
  active?: boolean;
  streamActive?: boolean;
  config?: {
    offsetMs: number; gamma: number; attack: number; decay: number; tickMs: number;
    minLevel?: number; maxLevel?: number;
    playheadSource?: PlayheadSource;
  };
  bindings?: StemBinding[];
  playhead?: { trackId: string | null; posS: number; playing: boolean; source?: PlayheadSource };
  envelope?: { trackId: string; sr: number; numSamples: number } | null;
  envelopeError?: string | null;
  channels?: Array<{
    rid: string;
    light: string | null;
    stems: Stem[];
    colorMode?: 'palette' | 'chroma';
    effectiveOffsetMs?: number;
    streamChannelId: number | null;
    value: number;
    level: number;
    chromaValue?: number;
    lastError: string | null;
  }>;
  error?: string | null;
}

export interface RestLight {
  rid: string;
  lmId: string;
  name: string;
}
