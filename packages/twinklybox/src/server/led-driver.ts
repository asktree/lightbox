// Generic interface that hides the differences between LED targets
// (Twinkly's UDP v3, WLED's DNRGB realtime, anything we add later).
// FrameLoop + patterns + viewer all talk to this — drivers handle the
// wire format.

export interface NormCoord { x: number; y: number; z: number }

export interface LedLayout {
  // 3D coords in [0,1] per axis, one entry per LED in strand order.
  coords: NormCoord[];
  // Optional 2D matrix dims (set for grid-shaped targets like a curtain).
  matrix?: { w: number; h: number };
  // Hint about where the coords came from: '3d', 'matrix', 'strand', etc.
  source: string;
}

// A physically-separate sub-display within one driver's frame (e.g. two
// non-contiguous WLED curtains driven as one buffer). Each segment gets its
// own normalized [0,1] layout — its own centroid — so patterns render per
// display instead of pretending the two are one contiguous surface.
export interface LedSegment {
  start: number;   // first LED index in the frame buffer
  numLeds: number;
  layout: LedLayout | null;
  label: string;
}

export interface LedDriver {
  // Identity for the UI.
  readonly kind: 'twinkly' | 'wled' | 'serial';
  readonly name: string;
  readonly host: string; // ip/hostname for display
  // Strand shape.
  readonly numLeds: number;
  readonly bytesPerLed: 3 | 4;
  // Spatial layout in a normalized form patterns can render against.
  // Method (not field) so concrete drivers can keep their own richer
  // internal layout types without name collisions.
  getLayout(): LedLayout | null;
  // Flip the device into a mode where it accepts our streamed frames.
  // For WLED this is a no-op (the firmware auto-detects realtime UDP).
  // For Twinkly this enters RT mode.
  startStreaming(): Promise<void>;
  // Hand control back to the device's normal effects.
  stopStreaming(): Promise<void>;
  // Optional: physically-separate sub-displays. When present, the frame
  // loop renders each segment independently (own pattern params + coords).
  getSegments?(): LedSegment[];
  // Ship one rendered frame. `buf` is RGB or RGBW bytes per LED matching
  // bytesPerLed × numLeds, in strand order.
  sendFrame(buf: Uint8Array): void;
  // Tear down sockets / cancel timers.
  dispose(): Promise<void>;
}
