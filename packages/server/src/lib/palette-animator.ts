/**
 * PaletteAnimator - Server-side palette animation controller
 *
 * Manages animation state per room:
 * - Which palette is active
 * - Whether animation is playing
 * - Light positions on the track
 *
 * Runs animation loops and updates lights via LightManager
 */

import { EventEmitter } from 'events';
import type { Palette, RoomState, PalettePositions } from '@lightbox/shared';
import { ROOMS, getPointOnPalette, positionToColor } from '@lightbox/shared';
import type { Database } from './database.js';
import type { LightManager } from './light-manager.js';

// 360ms tick halves bridge traffic vs. the original 180ms. The transition
// duration passed to each setLightState is the same interval, so bulbs
// interpolate across the gap — visually identical, 2× less pressure. With
// 6 lights in living we go from ~33 PUTs/sec (over Hue's ~10/sec budget)
// down to ~17, still over but less congested.
const UPDATE_INTERVAL_MS = 360;
const PERSIST_INTERVAL_TICKS = 9; // Persist every ~3 seconds at 360ms

// Default refresh interval for lights without custom settings (0 = use global UPDATE_INTERVAL_MS)
const DEFAULT_REFRESH_INTERVAL_MS = 0;

// Galaxy Projector can handle fast updates - use ready_for_more loop only for this device
const GALAXY_PROJECTOR_ID = 'tuya:ebc64ec87a6c462e20hmjo';

interface RoomAnimationState {
  roomId: string;
  activePaletteId: string | null;
  isPlaying: boolean;
  secondsPerNode: number;
  positions: PalettePositions;
  excludedLightIds: Set<string>;
  tickCount: number;
}

// How long to pause palette updates after user control (ms)
const USER_CONTROL_COOLDOWN_MS = 250;

export class PaletteAnimator extends EventEmitter {
  private roomStates: Map<string, RoomAnimationState> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private db: Database;
  private lightManager: LightManager;

  // Track lights being controlled by user (timestamp of last control)
  private userControlledLights: Map<string, number> = new Map();

  // Track last update time per light for per-light throttling
  private lastLightUpdateTime: Map<string, number> = new Map();

  constructor(db: Database, lightManager: LightManager) {
    super();
    this.db = db;
    this.lightManager = lightManager;

    // Listen for "ready for more" events - but only use fast loop for Galaxy Projector
    // Other Tuya devices get overwhelmed by rapid updates, causing ECONNRESET errors
    this.lightManager.on('ready_for_more', (deviceId: string) => {
      if (deviceId === GALAXY_PROJECTOR_ID) {
        this.sendImmediateUpdate(deviceId);
      }
    });
  }

  /**
   * Send an immediate color update to a specific light if it's in an active palette
   */
  private sendImmediateUpdate(lightId: string): void {
    // Skip if user is controlling this light
    if (this.isUserControlled(lightId)) return;

    // Find which room this light is in and if it has an active, playing palette
    for (const state of this.roomStates.values()) {
      if (!state.isPlaying || !state.activePaletteId) continue;

      // Skip excluded lights
      if (state.excludedLightIds.has(lightId)) continue;

      // Check if this light is in this room's animation
      const position = state.positions[lightId];
      if (position === undefined) continue;

      // Get the palette and calculate current color
      const palette = this.db.getPalette(state.activePaletteId);
      if (!palette || palette.nodes.length < 2) continue;

      const point = getPointOnPalette(palette, position);
      const { h, s } = positionToColor(point);

      // Send the update (this will trigger another ready_for_more when done)
      this.lightManager.setLightState(lightId, { color: { h, s } }, 100).catch(() => {
        // Ignore errors - light might be unreachable
      });

      return; // Found the light, we're done
    }
  }

  /**
   * Initialize - restore state from database for all rooms
   */
  async initialize(): Promise<void> {
    // Initialize state for all known rooms
    for (const roomId of Object.keys(ROOMS)) {
      const dbState = this.db.getRoomState(roomId);
      const room = ROOMS[roomId];

      // Get lights for this room
      const lightIds = room && room.lightIds.length > 0
        ? room.lightIds
        : Array.from(this.lightManager.getAllLights()).map(l => l.id);
      const roomLightSet = new Set(lightIds);

      // Load and filter positions to only include lights in this room
      let positions: Record<string, number> = {};
      if (dbState.activePaletteId) {
        const allPositions = this.db.getPalettePositions(dbState.activePaletteId);
        for (const [lightId, pos] of Object.entries(allPositions)) {
          if (roomLightSet.has(lightId)) {
            positions[lightId] = pos;
          }
        }
      }

      const state: RoomAnimationState = {
        roomId,
        activePaletteId: dbState.activePaletteId,
        isPlaying: dbState.isPlaying,
        secondsPerNode: dbState.secondsPerNode,
        positions,
        excludedLightIds: new Set(),
        tickCount: 0,
      };

      this.roomStates.set(roomId, state);

      // Resume animation if it was playing
      if (state.isPlaying && state.activePaletteId) {
        this.startAnimationLoop(roomId);
      }
    }

    console.log(`PaletteAnimator: initialized ${this.roomStates.size} rooms`);
  }

  /**
   * Select a palette for a room
   */
  async selectPalette(roomId: string, paletteId: string | null): Promise<void> {
    const state = this.getOrCreateState(roomId);

    // If changing palettes, stop current animation
    if (state.isPlaying) {
      this.stopAnimationLoop(roomId);
    }

    state.activePaletteId = paletteId;
    state.isPlaying = false;

    // Load saved positions for this palette, or initialize
    if (paletteId) {
      const allPositions = this.db.getPalettePositions(paletteId);

      // Get the lights for this room
      const room = ROOMS[roomId];
      const lightIds = room && room.lightIds.length > 0
        ? room.lightIds
        : Array.from(this.lightManager.getAllLights()).map(l => l.id);
      const roomLightSet = new Set(lightIds);

      // Filter positions to only include lights in this room
      state.positions = {};
      for (const [lightId, pos] of Object.entries(allPositions)) {
        if (roomLightSet.has(lightId)) {
          state.positions[lightId] = pos;
        }
      }

      // Initialize positions for lights that don't have saved positions
      let offset = Object.keys(state.positions).length;
      for (const lightId of lightIds) {
        if (!(lightId in state.positions)) {
          // Spread lights evenly along the track
          state.positions[lightId] = offset / lightIds.length;
          offset++;
        }
      }
    } else {
      state.positions = {};
    }

    // Persist state
    this.db.setRoomState(roomId, paletteId, false);
    if (paletteId) {
      this.db.savePalettePositions(paletteId, state.positions);
    }

    // Emit state change
    this.emitRoomState(roomId);
    if (paletteId) {
      this.emitPositions(roomId);
    }
  }

  /**
   * Start/resume animation for a room
   */
  async play(roomId: string): Promise<void> {
    const state = this.getOrCreateState(roomId);

    if (!state.activePaletteId) {
      throw new Error('No palette selected');
    }

    if (state.isPlaying) {
      return; // Already playing
    }

    state.isPlaying = true;
    this.db.setRoomState(roomId, state.activePaletteId, true);
    this.startAnimationLoop(roomId);
    this.emitRoomState(roomId);
  }

  /**
   * Pause animation for a room
   */
  async pause(roomId: string): Promise<void> {
    const state = this.roomStates.get(roomId);
    if (!state) return;

    if (!state.isPlaying) {
      return; // Already paused
    }

    state.isPlaying = false;
    this.stopAnimationLoop(roomId);
    this.db.setRoomState(roomId, state.activePaletteId, false);

    // Persist current positions
    if (state.activePaletteId) {
      this.db.savePalettePositions(state.activePaletteId, state.positions);
    }

    this.emitRoomState(roomId);
  }

  /**
   * Set animation speed for a room
   */
  async setSpeed(roomId: string, secondsPerNode: number): Promise<void> {
    const state = this.getOrCreateState(roomId);
    state.secondsPerNode = secondsPerNode;
    this.db.setRoomSpeed(roomId, secondsPerNode);
    this.emitRoomState(roomId);
  }

  /**
   * Set a light's position on the track (drag interaction)
   */
  async setLightPosition(roomId: string, lightId: string, position: number): Promise<void> {
    const state = this.roomStates.get(roomId);
    if (!state || !state.activePaletteId) return;

    state.positions[lightId] = position;

    // Persist immediately
    this.db.setPalettePosition(state.activePaletteId, lightId, position);

    // Update the light's color
    const palette = this.db.getPalette(state.activePaletteId);
    if (palette) {
      const point = getPointOnPalette(palette, position);
      const { h, s } = positionToColor(point);
      await this.lightManager.setLightState(lightId, { color: { h, s } }, 50);
    }

    // Emit position update
    this.emit('position_update', {
      roomId,
      paletteId: state.activePaletteId,
      lightId,
      position,
    });
  }

  /**
   * Get current state for a room
   */
  getRoomState(roomId: string): RoomState {
    const state = this.roomStates.get(roomId);
    if (!state) {
      return { roomId, activePaletteId: null, isPlaying: false, secondsPerNode: 20 };
    }
    return {
      roomId: state.roomId,
      activePaletteId: state.activePaletteId,
      isPlaying: state.isPlaying,
      secondsPerNode: state.secondsPerNode,
    };
  }

  /**
   * Get light positions for a room's active palette
   */
  getPositions(roomId: string): PalettePositions {
    const state = this.roomStates.get(roomId);
    return state?.positions ?? {};
  }

  /**
   * Get all room states (for initial sync)
   */
  getAllRoomStates(): RoomState[] {
    return Array.from(this.roomStates.values()).map(state => ({
      roomId: state.roomId,
      activePaletteId: state.activePaletteId,
      isPlaying: state.isPlaying,
      secondsPerNode: state.secondsPerNode,
    }));
  }

  /**
   * Set whether a light is excluded from palette animation
   */
  setLightExcluded(roomId: string, lightId: string, excluded: boolean): void {
    const state = this.getOrCreateState(roomId);
    if (excluded) {
      state.excludedLightIds.add(lightId);
    } else {
      state.excludedLightIds.delete(lightId);
    }
  }

  /**
   * Check if a light is excluded from palette animation
   */
  isLightExcluded(roomId: string, lightId: string): boolean {
    const state = this.roomStates.get(roomId);
    return state?.excludedLightIds.has(lightId) ?? false;
  }

  // ---- Pulse claim system ----
  //
  // Music-driven pulses (musicbox) want to drive a light's brightness via
  // REST attack/decay PUTs at whatever color the palette animator has most
  // recently set. Without coordination, the palette's periodic color
  // updates fight with the pulse's brightness writes. A "pulse claim"
  // excludes claimed lights from palette writes and exposes a way to look
  // up the current intended palette color so pulses can include it.

  private pulseClaimedLights: Set<string> = new Set();

  setPulseClaim(lightIds: string[]): void {
    const next = new Set(lightIds);
    // Unclaim previously-claimed lights that dropped out of the new set.
    for (const lid of this.pulseClaimedLights) {
      if (!next.has(lid)) {
        for (const state of this.roomStates.values()) state.excludedLightIds.delete(lid);
      }
    }
    // Claim newly added lights.
    for (const lid of next) {
      if (!this.pulseClaimedLights.has(lid)) {
        for (const state of this.roomStates.values()) state.excludedLightIds.add(lid);
      }
    }
    this.pulseClaimedLights = next;
  }

  isPulseClaimed(lightId: string): boolean {
    return this.pulseClaimedLights.has(lightId);
  }

  // Intended palette color for a light (the color the palette would be
  // setting if the light weren't pulse-claimed). Returns uint16 RGB so the
  // REST pulse can write it as xy. null if the light has no active palette.
  //
  // Respects position overrides (from external sources like musicbox
  // chroma bindings) when the override is fresh (TTL-gated).
  getPaletteColorForLight(lightId: string): { r: number; g: number; b: number } | null {
    for (const state of this.roomStates.values()) {
      if (!state.activePaletteId) continue;
      const position = this.effectivePosition(state, lightId);
      if (position === null) continue;
      const palette = this.db.getPalette(state.activePaletteId);
      if (!palette || palette.nodes.length < 2) continue;
      const point = getPointOnPalette(palette, position);
      const { h, s } = positionToColor(point);
      return hsvToRgb16(h, s / 100, 1);
    }
    return null;
  }

  // --- Palette position overrides ---
  //
  // External systems (e.g. musicbox chroma bindings) can push a 0-1 palette
  // position per light. The override wins over the time-driven natural
  // progression as long as it's fresh (TTL). When the push stops, positions
  // resume advancing naturally from wherever they are.

  private positionOverrides = new Map<string, { position: number; updatedAt: number }>();
  private static readonly POSITION_OVERRIDE_TTL_MS = 1500;

  setPositionOverride(lightId: string, position: number): void {
    this.positionOverrides.set(lightId, {
      position: Math.max(0, Math.min(1, position)),
      updatedAt: Date.now(),
    });
  }
  clearPositionOverride(lightId: string): void {
    this.positionOverrides.delete(lightId);
  }

  /** Position this light *should* render at, honoring overrides. null if no
   *  entry in positions and no override. */
  private effectivePosition(state: RoomAnimationState, lightId: string): number | null {
    const ov = this.positionOverrides.get(lightId);
    if (ov && Date.now() - ov.updatedAt < PaletteAnimator.POSITION_OVERRIDE_TTL_MS) {
      return ov.position;
    }
    const p = state.positions[lightId];
    return p === undefined ? null : p;
  }

  /**
   * Mark a light as being controlled by user (pauses palette updates temporarily)
   */
  markUserControlled(lightId: string): void {
    this.userControlledLights.set(lightId, Date.now());
  }

  /**
   * Check if a light is currently under user control (within cooldown period)
   */
  private isUserControlled(lightId: string): boolean {
    const timestamp = this.userControlledLights.get(lightId);
    if (!timestamp) return false;
    if (Date.now() - timestamp > USER_CONTROL_COOLDOWN_MS) {
      this.userControlledLights.delete(lightId);
      return false;
    }
    return true;
  }

  // ---- Private methods ----

  private getOrCreateState(roomId: string): RoomAnimationState {
    let state = this.roomStates.get(roomId);
    if (!state) {
      state = {
        roomId,
        activePaletteId: null,
        isPlaying: false,
        secondsPerNode: 20,
        positions: {},
        excludedLightIds: new Set(),
        tickCount: 0,
      };
      this.roomStates.set(roomId, state);
    }
    return state;
  }

  private startAnimationLoop(roomId: string): void {
    if (this.intervals.has(roomId)) {
      return; // Already running
    }

    const interval = setInterval(() => {
      this.tick(roomId);
    }, UPDATE_INTERVAL_MS);

    this.intervals.set(roomId, interval);
    console.log(`PaletteAnimator: started animation for room ${roomId}`);
  }

  private stopAnimationLoop(roomId: string): void {
    const interval = this.intervals.get(roomId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(roomId);
      console.log(`PaletteAnimator: stopped animation for room ${roomId}`);
    }
  }

  private tick(roomId: string): void {
    const state = this.roomStates.get(roomId);
    if (!state || !state.isPlaying || !state.activePaletteId) {
      return;
    }

    const palette = this.db.getPalette(state.activePaletteId);
    if (!palette || palette.nodes.length < 2) {
      return;
    }

    // Calculate position delta using room speed
    const totalTime = state.secondsPerNode * palette.nodes.length;
    const delta = (UPDATE_INTERVAL_MS / 1000) / totalTime;

    const now = Date.now();

    let wrote = 0, skippedExcluded = 0, skippedUser = 0, skippedThrottle = 0;
    // Update each light
    // TODO: Skip lights that are turned off (no point sending color updates to off lights)
    for (const lightId of Object.keys(state.positions)) {
      // User-controlled overrides palette entirely (don't even advance).
      if (this.isUserControlled(lightId)) { skippedUser++; continue; }

      // Advance position for ALL lights, including claimed ones. Claimed
      // lights get skipped from the bulb write below, but we still want
      // their palette position to move forward so pulse firings look up
      // the *current* color, not the one frozen at claim time.
      const currentPos = state.positions[lightId] ?? 0;
      const newPos = (currentPos + delta) % 1;
      state.positions[lightId] = newPos;

      // Skip the bulb write for claimed lights — musicbox is driving them.
      if (state.excludedLightIds.has(lightId)) { skippedExcluded++; continue; }

      // Check per-light refresh rate throttling
      const settings = this.lightManager.getLightSettings(lightId);
      const maxInterval = settings.maxRefreshIntervalMs || DEFAULT_REFRESH_INTERVAL_MS;

      if (maxInterval > 0) {
        const lastUpdate = this.lastLightUpdateTime.get(lightId) || 0;
        if (now - lastUpdate < maxInterval) {
          // Skip this update - not enough time has passed
          skippedThrottle++;
          continue;
        }
      }

      // Calculate color and update light — use override if fresh so
      // chroma-bound lights show the externally-driven position.
      const effPos = this.effectivePosition(state, lightId) ?? newPos;
      const point = getPointOnPalette(palette, effPos);
      const { h, s } = positionToColor(point);
      this.lightManager.setLightState(lightId, { color: { h, s } }, UPDATE_INTERVAL_MS).catch(() => {
        // Ignore errors during animation - light might be unreachable
      });

      // Record update time for throttling
      this.lastLightUpdateTime.set(lightId, now);
      wrote++;
    }

    // Broadcast positions to clients
    this.emitPositions(roomId);

    // Persist periodically
    state.tickCount++;
    if (state.tickCount % PERSIST_INTERVAL_TICKS === 0) {
      this.db.savePalettePositions(state.activePaletteId, state.positions);
    }
    // One line per ~second showing what the palette actually wrote. Helps
    // diagnose palette-vs-pulse contention without flooding.
    if (state.tickCount % 6 === 0) {
      const claimed = [...state.excludedLightIds].join(',') || '(none)';
      console.log(`[palette] room=${roomId} wrote=${wrote} excluded=${skippedExcluded} userCtrl=${skippedUser} throttle=${skippedThrottle} claimed=[${claimed}]`);
    }
  }

  private emitRoomState(roomId: string): void {
    const state = this.getRoomState(roomId);
    this.emit('room_state', state);
  }

  private emitPositions(roomId: string): void {
    const state = this.roomStates.get(roomId);
    if (!state || !state.activePaletteId) return;

    this.emit('palette_positions', {
      roomId,
      paletteId: state.activePaletteId,
      positions: state.positions,
    });
  }

  /**
   * Cleanup on shutdown
   */
  dispose(): void {
    // Stop all animation loops
    for (const [roomId] of this.intervals) {
      this.stopAnimationLoop(roomId);
    }

    // Persist all current positions
    for (const state of this.roomStates.values()) {
      if (state.activePaletteId && Object.keys(state.positions).length > 0) {
        this.db.savePalettePositions(state.activePaletteId, state.positions);
      }
    }
  }
}

// HSV (h:0-360, s/v:0-1) → uint16 RGB. Standard conversion; needed because
// positionToColor returns standard HSV but the REST pulse writes CIE xy
// computed from sRGB.
function hsvToRgb16(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; b = 0; }
  else if (hp < 2) { r = x; g = c; b = 0; }
  else if (hp < 3) { r = 0; g = c; b = x; }
  else if (hp < 4) { r = 0; g = x; b = c; }
  else if (hp < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const m = v - c;
  return {
    r: Math.round((r + m) * 65535),
    g: Math.round((g + m) * 65535),
    b: Math.round((b + m) * 65535),
  };
}
