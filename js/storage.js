// Almacenamiento local: IndexedDB (listas, favoritos, historial, EPG) + localStorage (preferencias).
const DB_NAME = 'nova-iptv';
const DB_VERSION = 1;
const STORES = ['playlists', 'favorites', 'history', 'epg', 'kv'];
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB no disponible'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('favorites')) db.createObjectStore('favorites', { keyPath: 'pk' });
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'pk' });
      if (!db.objectStoreNames.contains('epg')) db.createObjectStore('epg', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  getAll: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  delete: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
};

export async function clearAllData() {
  for (const s of STORES) await db.clear(s);
  try {
    localStorage.clear();
  } catch { /* noop */ }
}

// Preferencias sencillas
const PREFIX = 'nova.';
export const prefs = {
  get(key, def = null) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v === null ? def : JSON.parse(v);
    } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* noop */ }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* noop */ }
  },
};

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* noop */ }
  return false;
}
