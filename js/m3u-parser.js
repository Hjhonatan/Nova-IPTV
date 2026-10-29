// Parser M3U/M3U8 de listas IPTV. Trata todo el contenido como datos no confiables.
import { UNCATEGORIZED } from './config.js';

const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const ALLOWED_SCHEMES = /^(https?:)\/\//i;

function parseAttrs(str) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(str)) !== null) attrs[m[1].toLowerCase()] = m[2].trim();
  return attrs;
}

function cleanText(s, max = 200) {
  // Elimina caracteres de control; el texto se mostrará siempre con textContent.
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function safeLogo(url) {
  const u = String(url || '').trim();
  return ALLOWED_SCHEMES.test(u) ? u.slice(0, 500) : '';
}

/**
 * @param {string} text contenido de la lista
 * @returns {{channels: Array, skipped: number, warnings: string[]}}
 * Lanza Error con code 'EMPTY' | 'INVALID' si no es una lista válida.
 */
export function parseM3U(text) {
  if (typeof text !== 'string' || !text.trim()) {
    const e = new Error('empty'); e.code = 'EMPTY'; throw e;
  }
  text = text.replace(/^﻿/, '');
  const head = text.slice(0, 2000).trimStart();
  if (/^<(!doctype|html|\?xml)/i.test(head)) {
    const e = new Error('html'); e.code = 'INVALID'; throw e;
  }
  if (!/#EXTM3U/i.test(head) && !/#EXTINF/i.test(text.slice(0, 20000))) {
    const e = new Error('no-extm3u'); e.code = 'INVALID'; throw e;
  }

  const lines = text.split(/\r?\n/);
  const channels = [];
  let skipped = 0;
  let pending = null;
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = findNameComma(line);
      const meta = comma >= 0 ? line.slice(0, comma) : line;
      const name = comma >= 0 ? line.slice(comma + 1) : '';
      pending = { attrs: parseAttrs(meta), name: cleanText(name) };
    } else if (line.startsWith('#EXTGRP:') && pending) {
      pending.group = cleanText(line.slice(8), 100);
    } else if (line.startsWith('#')) {
      continue; // otras directivas (EXTVLCOPT, etc.) se ignoran: no se ejecuta nada
    } else {
      if (!pending) { // URL suelta sin EXTINF
        if (ALLOWED_SCHEMES.test(line)) {
          channels.push(build({ attrs: {}, name: '' }, line, channels.length));
        } else skipped++;
        continue;
      }
      if (!ALLOWED_SCHEMES.test(line)) { skipped++; pending = null; continue; }
      channels.push(build(pending, line, channels.length));
      pending = null;
    }
  }
  if (!channels.length) {
    const e = new Error('no-channels'); e.code = 'INVALID'; throw e;
  }
  if (skipped) warnings.push(`${skipped} entradas ignoradas (URL no válida o protocolo no compatible).`);
  return { channels, skipped, warnings };
}

// La coma que separa metadatos y nombre es la primera fuera de comillas.
function findNameComma(line) {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) return i;
  }
  return -1;
}

function build(p, url, idx) {
  const a = p.attrs;
  const name = cleanText(p.name) || cleanText(a['tvg-name']) || `Canal ${idx + 1}`;
  const group = cleanText(a['group-title'], 100) || p.group || UNCATEGORIZED;
  return {
    id: idx, // posición en la lista; estable mientras no se actualice
    key: hashKey(a['tvg-id'] || '', name, url),
    name,
    url: url.slice(0, 2000),
    logo: safeLogo(a['tvg-logo']),
    group,
    tvgId: cleanText(a['tvg-id'], 120),
    tvgName: cleanText(a['tvg-name'], 200),
    searchName: name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
  };
}

// Clave estable (para favoritos/recientes) que sobrevive a reordenaciones de la lista.
function hashKey(tvgId, name, url) {
  let path = url;
  try { const u = new URL(url); path = u.host + u.pathname; } catch { /* noop */ }
  const s = `${tvgId}|${name}|${path}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
