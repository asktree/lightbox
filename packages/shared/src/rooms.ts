/**
 * Room definitions - lights grouped by location
 * Shared between client and server
 */

export interface Room {
  name: string;
  lightIds: string[];
}

export const ROOMS: Record<string, Room> = {
  bedroom: {
    name: 'Bedroom',
    lightIds: ['hue:3', 'hue:4'], // spaceship floor, cockpit
  },
  living: {
    name: 'Living Room',
    lightIds: [
      'hue:2', 'hue:7', 'hue:6', // couch lights, iris
      'tuya:eb58e8db101aa08a03txnf', 'tuya:ebbacf4e20fe4b56366pik', // SUNVIE GU10s
      'tuya-ble:eb9f3b3flegezedk', 'tuya-ble:eba738os6ajviwqc', // BLE: Sunset Lamp, Smart Bulb
    ],
  },
  all: {
    name: 'All Lights',
    lightIds: [], // empty = show all
  },
};

// Lights to hide from all views (roommate's room, etc)
export const HIDDEN_LIGHT_IDS = new Set(['hue:8']); // Floor Lamp

// Get all room IDs
export const ROOM_IDS = Object.keys(ROOMS);
