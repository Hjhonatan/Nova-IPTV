// EPG XMLTV opcional. Se guarda por lista en IndexedDB; solo se conserva una ventana de tiempo útil.
import { db } from './storage.js';
import { fetchText } from './playlist-manager.js';
import { MAX_EPG_BYTES } from './config.js';

const WINDOW_PAST_MS = 3 * 3600e3;
const WINDOW_FUTURE_MS = 48 * 3600e3;
const memory = new Map(); // playlistId -> {url, updatedAt, programmes: {channelId:[{s,e,t}]}, names: {lowerName: channelId}}

/** XMLTV: 20261029161000 +0000 -> ms epoch */
export function parseXmltvDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4}|Z)?/.exec((s || '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se = '00', tz] = m;
  let off = 0;
  if (tz && tz !== 'Z') off = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) * 60000;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - off;
}

export function parseXmltv(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror') || !doc.documentElement || doc.documentElement.nodeName !== 'tv') {
    const e = new Error('invalid'); e.code = 'INVALID'; throw e;
  }
  const now = Date.now();
  const programmes = {};
  const names = {};
  for (const ch of doc.querySelectorAll('channel')) {
    const id = ch.getAttribute('id');
    if (!id) continue;
    for (const dn of ch.querySelectorAll('display-name')) {
      const n = (dn.textContent || '').trim().toLowerCase();
      if (n) names[n] = id;
    }
  }
  for (const p of doc.querySelectorAll('programme')) {
    const id = p.getAttribute('channel');
    const s = parseXmltvDate(p.getAttribute('start'));
    const e = parseXmltvDate(p.getAttribute('stop'));
    if (!id || isNaN(s) || isNaN(e)) continue;
    if (e < now - WINDOW_PAST_MS || s > now + WINDOW_FUTURE_MS) continue;
    const t = (p.querySelector('title')?.textContent || '').trim().slice(0, 200);
    if (!t) continue;
    (programmes[id] ||= []).push({ s, e, t });
  }
  for (const id in programmes) programmes[id].sort((a, b) => a.s - b.s);
  return { programmes, names };
}

export async function getEpgConfig(playlistId) {
  const rec = await db.get('epg', playlistId);
  if (rec) memory.set(playlistId, rec);
  return rec || null;
}

export async function updateEpg(playlistId, url, onStatus) {
  url = (url || '').trim();
  if (!url) { const e = new Error('empty'); e.code = 'NO_URL'; throw e; }
  const text = await fetchText(url, MAX_EPG_BYTES, onStatus);
  let data;
  try { data = parseXmltv(text); } catch (err) {
    const e = new Error('invalid'); e.code = 'INVALID'; throw e;
  }
  const rec = { id: playlistId, url, updatedAt: Date.now(), programmes: data.programmes, names: data.names };
  await db.put('epg', rec);
  memory.set(playlistId, rec);
  return { channels: Object.keys(data.programmes).length };
}

export async function removeEpg(playlistId) {
  await db.delete('epg', playlistId);
  memory.delete(playlistId);
}

export function hasEpg(playlistId) { return memory.has(playlistId); }

/** Devuelve {now, next} para un canal, o null si no hay datos. No inventa nada. */
export function nowNext(playlistId, channel) {
  const rec = memory.get(playlistId);
  if (!rec) return null;
  let id = channel.tvgId && rec.programmes[channel.tvgId] ? channel.tvgId : null;
  if (!id) {
    const byName = rec.names[channel.name.toLowerCase()] || rec.names[(channel.tvgName || '').toLowerCase()];
    if (byName && rec.programmes[byName]) id = byName;
  }
  if (!id) return null;
  const list = rec.programmes[id];
  const t = Date.now();
  const idx = list.findIndex((p) => p.s <= t && p.e > t);
  if (idx === -1) {
    const upcoming = list.find((p) => p.s > t);
    return upcoming ? { now: null, next: upcoming } : null;
  }
  return { now: list[idx], next: list[idx + 1] || null };
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
