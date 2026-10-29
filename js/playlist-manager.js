// Gestión de listas: importar por archivo/URL, actualizar, renombrar, eliminar.
import { db, prefs } from './storage.js';
import { parseM3U } from './m3u-parser.js';
import { MAX_IMPORT_BYTES, FETCH_TIMEOUT_MS } from './config.js';

export class AppError extends Error {
  constructor(code, userMessage, detail = '') {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
    this.detail = detail;
  }
}

/** Quita credenciales/tokens de una URL antes de mostrarla o registrarla. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    const user = u.username || u.password ? '***@' : '';
    return `${u.protocol}//${user}${u.host}${u.pathname.length > 24 ? u.pathname.slice(0, 24) + '…' : u.pathname}${u.search ? '?…' : ''}`;
  } catch { return '(URL no válida)'; }
}

function newId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function listPlaylists() {
  const all = await db.getAll('playlists');
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPlaylist(id) { return id ? db.get('playlists', id) : null; }

export function getActiveId() { return prefs.get('activePlaylist', null); }
export function setActiveId(id) { id ? prefs.set('activePlaylist', id) : prefs.remove('activePlaylist'); }

async function readTextLimited(res, maxBytes) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new AppError('TOO_BIG', 'La lista es demasiado grande (máximo ' + Math.round(maxBytes / 1048576) + ' MB).');
  if (!res.body || !res.body.getReader) {
    const t = await res.text();
    if (t.length > maxBytes) throw new AppError('TOO_BIG', 'La lista es demasiado grande.');
    return t;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let total = 0; let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { reader.cancel(); throw new AppError('TOO_BIG', 'La lista es demasiado grande (máximo ' + Math.round(maxBytes / 1048576) + ' MB).'); }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/** Descarga texto desde una URL con manejo de errores comprensibles. */
export async function fetchText(url, maxBytes, onStatus) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new AppError('BAD_URL', 'La dirección no es válida. Debe empezar por http:// o https://'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new AppError('BAD_URL', 'Solo se admiten direcciones http:// o https://');
  if (location.protocol === 'https:' && parsed.protocol === 'http:') {
    throw new AppError('MIXED', 'Esta app se sirve por HTTPS y el navegador bloquea descargar una lista desde una dirección http://. Usa una dirección https:// o importa el archivo.');
  }
  if (!navigator.onLine) throw new AppError('OFFLINE', 'No hay conexión a Internet.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    onStatus && onStatus('Descargando…');
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!res.ok) {
      const msg = res.status === 401 || res.status === 403
        ? 'El servidor rechazó la solicitud (acceso denegado).'
        : res.status === 404 ? 'El servidor no encontró la lista (404).'
          : `El servidor respondió con un error (${res.status}).`;
      throw new AppError('HTTP', msg, `HTTP ${res.status}`);
    }
    onStatus && onStatus('Procesando…');
    return await readTextLimited(res, maxBytes);
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e.name === 'AbortError') throw new AppError('TIMEOUT', 'La URL no respondió a tiempo.');
    // fetch() lanza TypeError tanto por red como por CORS: el navegador no distingue.
    throw new AppError('NETWORK_OR_CORS',
      'No se pudo descargar la lista. Puede que el servidor no responda o que no permita solicitudes desde el navegador (CORS). Prueba a descargar el archivo y a importarlo desde el dispositivo, o usa una fuente compatible con CORS / un proxy propio y autorizado.',
      String(e && e.message));
  } finally { clearTimeout(timer); }
}

function parseOrThrow(text) {
  try { return parseM3U(text); } catch (e) {
    if (e.code === 'EMPTY') throw new AppError('EMPTY', 'El archivo está vacío.');
    if (e.code === 'INVALID') throw new AppError('INVALID', 'El contenido no tiene formato M3U válido (no se encontraron canales).', e.message);
    throw e;
  }
}

async function save(rec) { await db.put('playlists', rec); return rec; }

export async function importFromFile(file, name) {
  if (!file) throw new AppError('NO_FILE', 'Selecciona un archivo .m3u o .m3u8.');
  if (file.size === 0) throw new AppError('EMPTY', 'El archivo está vacío.');
  if (file.size > MAX_IMPORT_BYTES) throw new AppError('TOO_BIG', 'El archivo es demasiado grande (máximo ' + Math.round(MAX_IMPORT_BYTES / 1048576) + ' MB).');
  const text = await file.text();
  const { channels, warnings } = parseOrThrow(text);
  const rec = await save({
    id: newId(), name: (name || file.name.replace(/\.(m3u8?|txt)$/i, '')).slice(0, 60) || 'Mi lista',
    source: 'file', url: '', channels, createdAt: Date.now(), updatedAt: Date.now(),
  });
  return { playlist: rec, warnings };
}

export async function importFromUrl(url, name, onStatus) {
  url = (url || '').trim();
  if (!url) throw new AppError('NO_URL', 'Pega la dirección de la lista.');
  const text = await fetchText(url, MAX_IMPORT_BYTES, onStatus);
  const { channels, warnings } = parseOrThrow(text);
  let host = 'Lista remota';
  try { host = new URL(url).host; } catch { /* noop */ }
  const rec = await save({
    id: newId(), name: (name || host).slice(0, 60),
    source: 'url', url, channels, createdAt: Date.now(), updatedAt: Date.now(),
  });
  return { playlist: rec, warnings };
}

/** Actualiza una lista remota. Si falla, la lista existente se conserva intacta. */
export async function refreshPlaylist(id, onStatus) {
  const pl = await db.get('playlists', id);
  if (!pl) throw new AppError('NOT_FOUND', 'La lista no existe.');
  if (pl.source !== 'url' || !pl.url) throw new AppError('LOCAL', 'Esta lista se importó desde un archivo. Para actualizarla, impórtala de nuevo.');
  const text = await fetchText(pl.url, MAX_IMPORT_BYTES, onStatus);
  const { channels, warnings } = parseOrThrow(text); // si lanza, no se toca la lista guardada
  pl.channels = channels;
  pl.updatedAt = Date.now();
  await save(pl);
  return { playlist: pl, warnings };
}

export async function renamePlaylist(id, name) {
  const pl = await db.get('playlists', id);
  if (!pl) return;
  pl.name = String(name || '').trim().slice(0, 60) || pl.name;
  await save(pl);
}

export async function deletePlaylist(id) {
  await db.delete('playlists', id);
  for (const store of ['favorites', 'history']) {
    const all = await db.getAll(store);
    for (const r of all) if (r.playlistId === id) await db.delete(store, r.pk);
  }
  await db.delete('epg', id).catch(() => {});
  if (getActiveId() === id) setActiveId(null);
}
