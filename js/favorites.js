// Favoritos (por lista) e historial de reproducción.
import { db, prefs } from './storage.js';
import { DEFAULT_HISTORY_LIMIT } from './config.js';

const pk = (playlistId, key) => `${playlistId}::${key}`;

// ---- Favoritos ----
let favCache = new Map(); // playlistId -> Set(keys)

export async function loadFavorites(playlistId) {
  const all = await db.getAll('favorites');
  const set = new Set(all.filter((r) => r.playlistId === playlistId).map((r) => r.key));
  favCache.set(playlistId, set);
  return set;
}
export function isFavorite(playlistId, key) {
  const s = favCache.get(playlistId); return !!s && s.has(key);
}
export async function toggleFavorite(playlistId, key) {
  let s = favCache.get(playlistId);
  if (!s) { s = new Set(); favCache.set(playlistId, s); }
  if (s.has(key)) { s.delete(key); await db.delete('favorites', pk(playlistId, key)); return false; }
  s.add(key);
  await db.put('favorites', { pk: pk(playlistId, key), playlistId, key, addedAt: Date.now() });
  return true;
}
export async function clearFavorites(playlistId) {
  const all = await db.getAll('favorites');
  for (const r of all) if (!playlistId || r.playlistId === playlistId) await db.delete('favorites', r.pk);
  if (playlistId) favCache.set(playlistId, new Set()); else favCache = new Map();
}
export function favoriteKeys(playlistId) { return favCache.get(playlistId) || new Set(); }

// ---- Historial ----
export function getHistoryLimit() { return prefs.get('historyLimit', DEFAULT_HISTORY_LIMIT); }
export function setHistoryLimit(n) { prefs.set('historyLimit', Math.max(5, Math.min(200, Number(n) || DEFAULT_HISTORY_LIMIT))); }

export async function addToHistory(playlistId, channel) {
  await db.put('history', {
    pk: pk(playlistId, channel.key), playlistId, key: channel.key,
    name: channel.name, logo: channel.logo, lastPlayed: Date.now(),
  });
  await trimHistory();
}
async function trimHistory() {
  const all = (await db.getAll('history')).sort((a, b) => b.lastPlayed - a.lastPlayed);
  const limit = getHistoryLimit();
  for (const r of all.slice(limit)) await db.delete('history', r.pk);
}
export async function getHistory(playlistId) {
  const all = await db.getAll('history');
  return all.filter((r) => r.playlistId === playlistId).sort((a, b) => b.lastPlayed - a.lastPlayed);
}
export async function removeFromHistory(playlistId, key) { await db.delete('history', pk(playlistId, key)); }
export async function clearHistory() { await db.clear('history'); }

// ---- Último canal ----
export function saveLastChannel(playlistId, key) { prefs.set('lastChannel', { playlistId, key }); }
export function getLastChannel() { return prefs.get('lastChannel', null); }
