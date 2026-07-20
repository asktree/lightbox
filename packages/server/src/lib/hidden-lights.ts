// Lights that must not appear in ANY of our UIs. These belong to other
// people (roommates) — surfacing them invites accidentally flashing
// someone else's room. Filtered at the server so every consumer
// (lightbox client, musicbox dashboards, musicbox2 drive rail) inherits
// the exclusion. Matched on trimmed, lowercased device name.

const HIDDEN_LIGHT_NAMES = new Set([
  'bedside lamp', // roommate's — hands off
]);

export function isHiddenLightName(name: string | undefined | null): boolean {
  if (!name) return false;
  return HIDDEN_LIGHT_NAMES.has(name.trim().toLowerCase());
}
