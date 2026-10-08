import { describe, it, expect } from 'vitest';
import { PaletteAnimator } from '../src/lib/palette-animator.js';

function makeAnimator() {
  const calls: Array<[string, string | null, boolean]> = [];
  const db = {
    setRoomState: (room: string, pal: string | null, playing: boolean) => calls.push([room, pal, playing]),
    savePalettePositions: () => {},
  };
  const lightManager = { on: () => {} };
  const a = new PaletteAnimator(db as any, lightManager as any);
  const states = (a as any).roomStates as Map<string, any>;
  const add = (roomId: string, ids: string[], playing: boolean, excluded: string[] = []) =>
    states.set(roomId, {
      roomId, activePaletteId: 'p1', isPlaying: playing, secondsPerNode: 20,
      positions: Object.fromEntries(ids.map((id, i) => [id, i / ids.length])),
      excludedLightIds: new Set(excluded), tickCount: 0,
    });
  return { a, add, calls };
}

describe('pauseRoomsWithLights', () => {
  it('pauses a playing palette that drives a dial light', async () => {
    const { a, add, calls } = makeAnimator();
    add('bedroom', ['hue:3', 'hue:4'], true);
    expect(await a.pauseRoomsWithLights(['hue:3'])).toEqual(['bedroom']);
    expect(a.getRoomState('bedroom')).toMatchObject({ activePaletteId: 'p1', isPlaying: false });
    expect(calls).toEqual([['bedroom', 'p1', false]]);
  });

  it('pauses the all-lights room too', async () => {
    const { a, add } = makeAnimator();
    add('bedroom', ['hue:3', 'hue:4'], true);
    add('all', ['hue:1', 'hue:3', 'hue:4'], true);
    expect((await a.pauseRoomsWithLights(['hue:3', 'hue:4'])).sort()).toEqual(['all', 'bedroom']);
  });

  it('leaves other rooms, paused rooms and excluded lights alone', async () => {
    const { a, add, calls } = makeAnimator();
    add('living', ['hue:1', 'hue:2'], true);
    add('bedroom', ['hue:3', 'hue:4'], false);
    add('all', ['hue:1', 'hue:3'], true, ['hue:3']);
    expect(await a.pauseRoomsWithLights(['hue:3', 'hue:4'])).toEqual([]);
    expect(a.getRoomState('living').isPlaying).toBe(true);
    expect(calls).toEqual([]);
  });
});
