// Nova IPTV — controlador principal de la interfaz.
// Todo el contenido que viene de las listas (nombres, logos, grupos) se inserta con textContent / atributos,
// nunca como HTML.
import { APP_NAME, APP_VERSION } from './config.js';
import { prefs, clearAllData, requestPersistence } from './storage.js';
import * as PM from './playlist-manager.js';
import * as FAV from './favorites.js';
import { categoriesOf, filterChannels, debounce } from './search.js';
import * as EPG from './epg.js';
import { createPlayer } from './player.js';

const $ = (id) => document.getElementById(id);
const PAGE = 100;

const ICONS = {
  tv: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12C19 16.6 12 21 12 21z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

const state = {
  tab: 'home',
  playlists: [],
  active: null, // registro de lista activa
  byKey: new Map(),
  query: '', category: '', sort: prefs.get('sort', 'list'),
  limit: PAGE,
  ctx: [], ctxIndex: -1, // contexto de reproducción (para anterior/siguiente)
  recordedThisPlay: false,
  deferredInstall: null,
};

// ---------- utilidades DOM ----------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v; // solo para constantes internas (ICONS)
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

let toastTimer;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function modal(build) {
  return new Promise((resolve) => {
    const m = $('modal'); const card = m.querySelector('.modal-card');
    card.replaceChildren();
    const close = (v) => { m.hidden = true; card.replaceChildren(); m.onclick = null; resolve(v); };
    build(card, close);
    m.hidden = false;
    m.onclick = (e) => { if (e.target === m) close(null); };
  });
}
function confirmDialog(title, text, okLabel = 'Aceptar', danger = false) {
  return modal((card, close) => {
    card.append(h('h3', { text: title }), h('p', { class: 'muted', text }),
      h('div', { class: 'row' },
        h('button', { class: 'btn' + (danger ? ' danger' : ' primary'), text: okLabel, onclick: () => close(true) }),
        h('button', { class: 'btn ghost', text: 'Cancelar', onclick: () => close(false) })));
  }).then(Boolean);
}
function promptDialog(title, value) {
  return modal((card, close) => {
    const input = h('input', { type: 'text', value, maxlength: 60 });
    card.append(h('h3', { text: title }), h('div', { class: 'field' }, input),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', text: 'Guardar', onclick: () => close(input.value) }),
        h('button', { class: 'btn ghost', text: 'Cancelar', onclick: () => close(null) })));
    setTimeout(() => input.focus(), 50);
  });
}

/** Mensaje de estado con "Detalles técnicos" opcional. */
function statusMsg(host, kind, text, detail) {
  host.replaceChildren();
  if (!text) return;
  const box = h('div', { class: 'msg ' + (kind || '') }, text);
  if (detail) {
    const pre = h('pre', { text: detail }); pre.hidden = true;
    box.append(h('div', {}, h('button', { class: 'btn ghost small', text: 'Detalles técnicos', onclick: () => { pre.hidden = !pre.hidden; } })), pre);
  }
  host.append(box);
}
function errorText(e) {
  if (e instanceof PM.AppError) return { text: e.userMessage, detail: e.detail };
  if (e && e.code === 'INVALID') return { text: 'El contenido no tiene el formato esperado.', detail: '' };
  if (e && e.code === 'NO_URL') return { text: 'Pega la dirección primero.', detail: '' };
  return { text: 'Ocurrió un error inesperado.', detail: String((e && e.message) || e) };
}

function logoBox(ch, cls = 'logo-box') {
  const box = h('div', { class: cls });
  const generic = () => { box.replaceChildren(); box.innerHTML = ICONS.tv; };
  if (ch.logo) {
    const img = h('img', { src: ch.logo, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', generic, { once: true });
    box.append(img);
  } else generic();
  return box;
}

// ---------- listas / activación ----------
async function refreshPlaylists() { state.playlists = await PM.listPlaylists(); }

async function activate(id) {
  const pl = state.playlists.find((p) => p.id === id) || null;
  state.active = pl;
  state.byKey = new Map();
  state.category = ''; state.limit = PAGE;
  if (pl) {
    for (const c of pl.channels) state.byKey.set(c.key, c);
    PM.setActiveId(pl.id);
    await FAV.loadFavorites(pl.id);
    await EPG.getEpgConfig(pl.id);
  } else PM.setActiveId(null);
  updateStatus();
}
function updateStatus() {
  const d = $('statusDot');
  if (state.active) { d.className = 'status-dot ok'; d.title = `${state.active.name} · ${state.active.channels.length} canales`; }
  else { d.className = 'status-dot'; d.title = 'Sin lista'; }
}

// ---------- navegación ----------
function go(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
  $('view').scrollTop = 0;
}
function render() {
  const v = $('view');
  v.replaceChildren();
  ({ home: renderHome, live: renderLive, favorites: renderFavorites, recent: renderRecent, lists: renderLists, settings: renderSettings }[state.tab] || renderHome)(v);
}

function emptyNoList() {
  return h('div', { class: 'empty' },
    h('h2', { text: 'Aún no hay ninguna lista' }),
    h('p', { text: 'Importa tu lista M3U desde un archivo o una dirección web. Nova IPTV no incluye canales ni listas.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', text: 'Añadir lista', onclick: () => go('lists') })));
}

// ---------- filas y tiles ----------
function chanRow(ch, ctx, opts = {}) {
  const pid = state.active.id;
  const fav = h('button', { class: 'fav-btn' + (FAV.isFavorite(pid, ch.key) ? ' on' : ''), 'aria-label': 'Favorito', html: ICONS.heart });
  fav.addEventListener('click', async (e) => {
    e.stopPropagation();
    const on = await FAV.toggleFavorite(pid, ch.key);
    fav.classList.toggle('on', on);
    if (state.tab === 'favorites' && !on) render();
    syncPlayerFav();
  });
  const sub = [ch.group];
  if (EPG.hasEpg(pid)) { const nn = EPG.nowNext(pid, ch); if (nn && nn.now) sub.unshift(nn.now.t); }
  const row = h('div', { class: 'chan compact-ok' + (opts.compact ? ' compact' : '') + (player.current && player.current.key === ch.key ? ' current' : ''), role: 'button', tabindex: 0, 'data-key': ch.key },
    logoBox(ch), h('div', { class: 'meta' }, h('div', { class: 'name', text: ch.name }), h('div', { class: 'sub', text: sub.join(' · ') })), fav);
  const open = () => playChannel(ch, ctx);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return row;
}
function tile(ch, ctx) {
  const t = h('button', { class: 'tile' }, logoBox(ch), h('div', { class: 't-name', text: ch.name }));
  t.addEventListener('click', () => playChannel(ch, ctx));
  return t;
}

// ---------- Inicio ----------
async function renderHome(v) {
  if (!state.playlists.length || !state.active) { v.append(emptyNoList()); return; }
  const pid = state.active.id;
  const last = FAV.getLastChannel();
  const lastCh = last && last.playlistId === pid ? state.byKey.get(last.key) : null;
  if (lastCh) {
    const hero = h('button', { class: 'hero' },
      h('div', { class: 'play-circle', html: ICONS.play }),
      h('div', {}, h('div', { class: 'muted small', text: 'Continuar viendo' }), h('strong', { text: lastCh.name }), h('div', { class: 'muted small', text: lastCh.group })));
    hero.addEventListener('click', () => playChannel(lastCh, state.active.channels));
    v.append(hero);
  }
  const favs = [...FAV.favoriteKeys(pid)].map((k) => state.byKey.get(k)).filter(Boolean);
  if (favs.length) v.append(h('h3', { class: 'section-title', text: 'Favoritos' }), h('div', { class: 'hscroll' }, favs.slice(0, 20).map((c) => tile(c, favs))));
  const hist = (await FAV.getHistory(pid)).map((r) => state.byKey.get(r.key)).filter(Boolean);
  if (state.tab !== 'home') return; // el usuario cambió de pestaña mientras se cargaba
  if (hist.length) v.append(h('h3', { class: 'section-title', text: 'Vistos recientemente' }), h('div', { class: 'hscroll' }, hist.slice(0, 20).map((c) => tile(c, hist))));
  v.append(h('h3', { class: 'section-title', text: 'Lista activa' }),
    h('div', { class: 'card' },
      h('strong', { text: state.active.name }),
      h('div', { class: 'muted small', text: `${state.active.channels.length} canales · actualizada ${fmtDate(state.active.updatedAt)}` }),
      h('div', { class: 'row', style: null }, h('button', { class: 'btn primary small', text: 'Ver canales', onclick: () => go('live') }), h('button', { class: 'btn small', text: 'Cambiar lista', onclick: () => go('lists') }))));
  if (!lastCh && !favs.length && !hist.length) v.append(h('p', { class: 'muted', text: 'Abre «En vivo» para elegir un canal. Tus favoritos y recientes aparecerán aquí.' }));
}

// ---------- En vivo ----------
function renderLive(v) {
  if (!state.active) { v.append(emptyNoList()); return; }
  const all = state.active.channels;
  const base = filterChannels(all, { query: state.query });
  const cats = categoriesOf(base);
  if (state.category && !cats.some((c) => c.name === state.category)) state.category = '';
  const chip = (label, count, value) => h('button', { class: 'chip' + (state.category === value ? ' active' : ''), onclick: () => { state.category = value; state.limit = PAGE; render(); } }, label, h('small', { text: String(count) }));
  v.append(h('div', { class: 'chips' }, chip('Todas', base.length, ''), cats.map((c) => chip(c.name, c.count, c.name))));
  const sortSel = h('select', { 'aria-label': 'Orden' }, h('option', { value: 'list', text: 'Orden de la lista' }), h('option', { value: 'az', text: 'A – Z' }));
  sortSel.value = state.sort;
  sortSel.addEventListener('change', () => { state.sort = sortSel.value; prefs.set('sort', state.sort); state.limit = PAGE; fillList(); });
  const count = h('span', { class: 'muted small' });
  v.append(h('div', { class: 'toolbar' }, sortSel, count));
  const host = h('div', { class: 'chan-list' }); v.append(host);
  const more = h('div', { class: 'more' }); v.append(more);
  let list = [];
  let observer = null;
  function fillList() {
    list = filterChannels(all, { query: state.query, category: state.category, sort: state.sort });
    count.textContent = `${list.length} canales`;
    host.replaceChildren();
    if (!list.length) { host.append(h('div', { class: 'empty', text: state.query ? 'Ningún canal coincide con la búsqueda.' : 'No hay canales en esta categoría.' })); more.replaceChildren(); return; }
    appendPage();
  }
  function appendPage() {
    const start = host.children.length;
    const frag = document.createDocumentFragment();
    for (const ch of list.slice(start, state.limit)) frag.append(chanRow(ch, list));
    host.append(frag);
    more.replaceChildren();
    if (host.children.length < list.length) {
      more.append(h('button', { class: 'btn small', text: `Mostrar más (${list.length - host.children.length})`, onclick: () => { state.limit += PAGE; appendPage(); } }));
      if ('IntersectionObserver' in window) {
        if (observer) observer.disconnect();
        observer = new IntersectionObserver((es) => { if (es[0].isIntersecting) { observer.disconnect(); state.limit += PAGE; appendPage(); } }, { root: $('view'), rootMargin: '400px' });
        observer.observe(more);
      }
    }
  }
  fillList();
}

// ---------- Favoritos ----------
function renderFavorites(v) {
  if (!state.active) { v.append(emptyNoList()); return; }
  const keys = FAV.favoriteKeys(state.active.id);
  const list = filterChannels(state.active.channels, { onlyKeys: keys, query: state.query, sort: state.sort });
  if (!list.length) {
    v.append(h('div', { class: 'empty' }, h('h2', { text: 'Sin favoritos' }), h('p', { text: 'Toca el corazón en cualquier canal para guardarlo aquí.' })));
    return;
  }
  v.append(h('div', { class: 'chan-list' }, list.slice(0, 500).map((c) => chanRow(c, list))));
}

// ---------- Recientes ----------
async function renderRecent(v) {
  if (!state.active) { v.append(emptyNoList()); return; }
  const pid = state.active.id;
  const hist = (await FAV.getHistory(pid)).filter((r) => state.byKey.has(r.key));
  if (state.tab !== 'recent') return;
  if (!hist.length) { v.append(h('div', { class: 'empty' }, h('h2', { text: 'Sin historial' }), h('p', { text: 'Los canales que veas aparecerán aquí.' }))); return; }
  const ctx = hist.map((r) => state.byKey.get(r.key));
  v.append(h('div', { class: 'toolbar' }, h('span', { class: 'muted small', text: `${hist.length} canales` }),
    h('button', { class: 'btn danger small', text: 'Borrar historial', onclick: async () => { if (await confirmDialog('Borrar historial', 'Se eliminarán todos los canales recientes.', 'Borrar', true)) { await FAV.clearHistory(); render(); } } })));
  const host = h('div', { class: 'chan-list' });
  hist.forEach((r, i) => {
    const row = chanRow(state.byKey.get(r.key), ctx);
    row.querySelector('.sub').textContent = fmtDate(r.lastPlayed);
    const del = h('button', { class: 'fav-btn', 'aria-label': 'Quitar del historial', html: ICONS.trash });
    del.addEventListener('click', async (e) => { e.stopPropagation(); await FAV.removeFromHistory(pid, r.key); row.remove(); });
    row.append(del);
    host.append(row);
  });
  v.append(host);
}

// ---------- Listas ----------
function renderLists(v) {
  const status = h('div');
  const nameIn = h('input', { type: 'text', id: 'plName', placeholder: 'Mi lista', maxlength: 60 });
  const urlIn = h('input', { type: 'url', id: 'plUrl', placeholder: 'https://…/lista.m3u', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const fileIn = h('input', { type: 'file', accept: '.m3u,.m3u8,.txt,audio/mpegurl,audio/x-mpegurl,application/vnd.apple.mpegurl,application/x-mpegurl,text/plain', hidden: true });
  const btnUrl = h('button', { class: 'btn primary', text: 'Importar desde URL' });
  const btnFile = h('button', { class: 'btn', text: 'Elegir archivo .m3u / .m3u8' });

  async function afterImport(res) {
    await refreshPlaylists();
    await activate(res.playlist.id);
    statusMsg(status, 'ok', `Importados ${res.playlist.channels.length} canales en «${res.playlist.name}».` + (res.warnings.length ? ' ' + res.warnings.join(' ') : ''));
    nameIn.value = ''; urlIn.value = '';
    renderListItems();
  }
  btnFile.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return;
    btnFile.disabled = true; statusMsg(status, '', 'Procesando archivo…');
    try { await afterImport(await PM.importFromFile(f, nameIn.value.trim())); } catch (e) { const t = errorText(e); statusMsg(status, 'err', t.text, t.detail); }
    btnFile.disabled = false; fileIn.value = '';
  });
  btnUrl.addEventListener('click', async () => {
    const url = urlIn.value.trim();
    if (!url) { statusMsg(status, 'err', 'Pega la dirección de la lista.'); urlIn.focus(); return; }
    btnUrl.disabled = true;
    try { await afterImport(await PM.importFromUrl(url, nameIn.value.trim(), (s) => statusMsg(status, '', s))); } catch (e) { const t = errorText(e); statusMsg(status, 'err', t.text, t.detail); }
    btnUrl.disabled = false;
  });

  v.append(h('div', { class: 'card' },
    h('h3', { text: 'Añadir lista' }),
    h('p', { class: 'muted small', text: 'Tu lista se guarda solo en este dispositivo. No se envía a ningún servidor.' }),
    h('div', { class: 'field' }, h('label', { for: 'plName', text: 'Nombre (opcional)' }), nameIn),
    h('div', { class: 'field' }, h('label', { for: 'plUrl', text: 'Dirección (URL) de la lista' }), urlIn),
    h('div', { class: 'row' }, btnUrl, btnFile), fileIn, status));

  v.append(h('h3', { class: 'section-title', text: 'Mis listas' }));
  const host = h('div'); v.append(host);

  function renderListItems() {
    host.replaceChildren();
    if (!state.playlists.length) { host.append(h('p', { class: 'muted', text: 'Todavía no has importado ninguna lista.' })); return; }
    for (const pl of state.playlists) {
      const isActive = state.active && state.active.id === pl.id;
      const msg = h('div');
      const item = h('div', { class: 'card pl-item' + (isActive ? ' active' : '') },
        h('div', { class: 'pl-head' }, h('strong', { text: pl.name }), isActive ? h('span', { class: 'badge', text: 'Activa' }) : null),
        h('div', { class: 'muted small', text: `${pl.channels.length} canales · ${pl.source === 'url' ? PM.redactUrl(pl.url) : 'archivo local'}` }),
        h('div', { class: 'muted small', text: `Última actualización: ${fmtDate(pl.updatedAt)}` }),
        h('div', { class: 'row' },
          !isActive ? h('button', { class: 'btn primary small', text: 'Usar', onclick: async () => { await activate(pl.id); renderListItems(); toast(`Lista activa: ${pl.name}`); } }) : null,
          pl.source === 'url' ? h('button', { class: 'btn small', text: 'Actualizar', onclick: async (e) => {
            e.target.disabled = true;
            try { const r = await PM.refreshPlaylist(pl.id, (s) => statusMsg(msg, '', s)); await refreshPlaylists(); if (isActive) await activate(pl.id); renderListItems(); toast(`Lista actualizada: ${r.playlist.channels.length} canales`); return; }
            catch (er) { const t = errorText(er); statusMsg(msg, 'err', t.text + ' Tu lista anterior se conserva.', t.detail); }
            e.target.disabled = false;
          } }) : null,
          h('button', { class: 'btn small', text: 'Renombrar', onclick: async () => { const n = await promptDialog('Nombre de la lista', pl.name); if (n && n.trim()) { await PM.renamePlaylist(pl.id, n); await refreshPlaylists(); if (isActive) await activate(pl.id); renderListItems(); } } }),
          h('button', { class: 'btn danger small', text: 'Eliminar', onclick: async () => {
            if (!(await confirmDialog('Eliminar lista', `Se eliminará «${pl.name}» junto con sus favoritos e historial. Esta acción no se puede deshacer.`, 'Eliminar', true))) return;
            await PM.deletePlaylist(pl.id); await refreshPlaylists();
            if (isActive) await activate(state.playlists[0] ? state.playlists[0].id : null);
            renderListItems(); toast('Lista eliminada');
          } })),
        msg);
      host.append(item);
    }
  }
  renderListItems();
}

// ---------- Ajustes ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === 'light' ? '#f5f6fa' : '#0b0b0f';
}
function renderSettings(v) {
  const pid = state.active && state.active.id;
  const themeSel = h('select', {}, h('option', { value: 'dark', text: 'Oscuro' }), h('option', { value: 'light', text: 'Claro' }));
  themeSel.value = prefs.get('theme', 'dark');
  themeSel.addEventListener('change', () => { prefs.set('theme', themeSel.value); applyTheme(themeSel.value); });
  v.append(h('div', { class: 'card' }, h('h3', { text: 'Apariencia' }), h('div', { class: 'toggle' }, h('span', { text: 'Tema' }), themeSel)));

  // Reproducción
  const upg = h('input', { type: 'checkbox', 'aria-label': 'Probar https en canales http' });
  upg.checked = prefs.get('upgradeHttp', true);
  upg.addEventListener('change', () => prefs.set('upgradeHttp', upg.checked));
  v.append(h('h3', { class: 'section-title', text: 'Reproducción' }), h('div', { class: 'card' },
    h('label', { class: 'toggle' }, h('span', {}, 'Probar https:// en canales http://', h('div', { class: 'muted small', text: 'El navegador bloquea canales http:// desde una página HTTPS. Con esto se intenta la versión https:// del mismo canal; solo funciona si el servidor la admite.' })), upg)));

  // Listas
  const plStatus = h('div');
  v.append(h('h3', { class: 'section-title', text: 'Listas' }), h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('button', { class: 'btn small', text: 'Gestionar listas', onclick: () => go('lists') }),
      h('button', { class: 'btn small', text: 'Actualizar listas remotas', onclick: async (e) => {
        const remotes = state.playlists.filter((p) => p.source === 'url');
        if (!remotes.length) { statusMsg(plStatus, '', 'No hay listas remotas que actualizar.'); return; }
        e.target.disabled = true; let ok = 0; const fails = [];
        for (const p of remotes) { try { await PM.refreshPlaylist(p.id); ok++; } catch (er) { fails.push(`${p.name}: ${errorText(er).text}`); } }
        await refreshPlaylists(); if (state.active) await activate(state.active.id);
        statusMsg(plStatus, fails.length ? 'err' : 'ok', `${ok} actualizadas.` + (fails.length ? ' Fallaron: ' + fails.join(' | ') + ' (se conservan las listas anteriores).' : ''));
        e.target.disabled = false;
      } })), plStatus));

  // EPG
  const epgStatus = h('div');
  const epgCard = h('div', { class: 'card' }, h('h3', { text: 'Guía de programación (EPG, XMLTV)' }));
  if (!pid) epgCard.append(h('p', { class: 'muted small', text: 'Importa una lista para configurar la guía.' }));
  else {
    EPG.getEpgConfig(pid).then((cfg) => {
      const urlIn = h('input', { type: 'url', placeholder: 'https://…/guia.xml', value: cfg ? cfg.url : '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      epgCard.append(
        h('p', { class: 'muted small', text: cfg ? `Guía configurada · actualizada ${fmtDate(cfg.updatedAt)}` : 'No hay guía configurada (opcional). No se muestra información de programación si no la añades.' }),
        h('div', { class: 'field' }, h('label', { text: 'URL de la guía XMLTV' }), urlIn),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', text: cfg ? 'Actualizar guía' : 'Importar guía', onclick: async (e) => {
            e.target.disabled = true;
            try { const r = await EPG.updateEpg(pid, urlIn.value, (s) => statusMsg(epgStatus, '', s)); statusMsg(epgStatus, 'ok', `Guía importada (${r.channels} canales con programación).`); }
            catch (er) {
              if (er.code === 'INVALID') statusMsg(epgStatus, 'err', 'El archivo no es una guía XMLTV válida. La guía anterior se conserva.');
              else { const t = errorText(er); statusMsg(epgStatus, 'err', 'No se pudo actualizar la guía. ' + t.text, t.detail); }
            }
            e.target.disabled = false;
          } }),
          cfg ? h('button', { class: 'btn danger small', text: 'Quitar guía', onclick: async () => { await EPG.removeEpg(pid); render(); } }) : null),
        epgStatus);
    });
  }
  v.append(h('h3', { class: 'section-title', text: 'Guía' }), epgCard);

  // Datos
  const limIn = h('input', { type: 'number', min: 5, max: 200, value: FAV.getHistoryLimit(), 'aria-label': 'Límite del historial' });
  limIn.addEventListener('change', () => { FAV.setHistoryLimit(limIn.value); limIn.value = FAV.getHistoryLimit(); });
  v.append(h('h3', { class: 'section-title', text: 'Datos' }), h('div', { class: 'card' },
    h('div', { class: 'toggle' }, h('span', { text: 'Máximo de canales en el historial' }), h('span', { style: null }, limIn)),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', text: 'Borrar historial', onclick: async () => { if (await confirmDialog('Borrar historial', 'Se eliminarán todos los canales recientes.', 'Borrar', true)) { await FAV.clearHistory(); toast('Historial borrado'); } } }),
      h('button', { class: 'btn small', text: 'Borrar favoritos de la lista activa', onclick: async () => { if (!pid) return; if (await confirmDialog('Borrar favoritos', 'Se quitarán todos los favoritos de la lista activa.', 'Borrar', true)) { await FAV.clearFavorites(pid); toast('Favoritos borrados'); } } }),
      h('button', { class: 'btn danger small', text: 'Borrar todos los datos locales', onclick: async () => {
        if (!(await confirmDialog('Borrar todos los datos', 'Se eliminarán TODAS las listas, favoritos, historial, guías y ajustes de este dispositivo. No se puede deshacer.', 'Borrar todo', true))) return;
        player.stop(); await clearAllData(); location.reload();
      } }))));

  // Info
  const persist = h('div', { class: 'muted small', text: 'Tus datos se guardan solo en este dispositivo y pueden perderse si borras los datos del navegador o desinstalas la app.' });
  const info = h('div', { class: 'card' }, h('h3', { text: 'Información' }),
    h('p', { class: 'small', text: `${APP_NAME} · versión ${APP_VERSION}` }),
    h('p', { class: 'muted small', text: 'Reproductor y organizador de listas M3U. No incluye canales ni listas, no tiene anuncios ni rastreadores y no envía tus datos a terceros.' }), persist);
  if (state.deferredInstall) info.append(h('div', { class: 'row' }, h('button', { class: 'btn primary small', text: 'Instalar app', onclick: async () => { state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; render(); } })));
  v.append(h('h3', { class: 'section-title', text: 'Acerca de' }), info);
}

// ---------- Reproductor ----------
const player = createPlayer({
  video: $('video'), wrap: $('playerStage'), spinner: $('spinner'),
  errorBox: $('errorBox'), errorMsg: $('errorMsg'), errorDetailBtn: $('btnErrorDetail'), errorDetail: $('errorDetail'),
}, {
  onChannel: onPlayerChannel,
  getUpgradeHttp: () => prefs.get('upgradeHttp', true),
  onState: (s) => {
    $('icoPlay').hidden = s === 'playing'; $('icoPause').hidden = s !== 'playing';
    if (s === 'playing') {
      scheduleHide();
      if (!state.recordedThisPlay && player.current && state.active) { state.recordedThisPlay = true; FAV.addToHistory(state.active.id, player.current); }
    } else showControls(true);
  },
  onVolume: (v) => { $('icoVol').hidden = v.muted || v.volume === 0; $('icoMute').hidden = !(v.muted || v.volume === 0); },
  onError: () => showControls(true),
});

let hideTimer;
function showControls(sticky) {
  const c = $('controls'); c.classList.remove('hide'); clearTimeout(hideTimer);
  if (!sticky) scheduleHide();
}
function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!$('video').paused && $('errorBox').hidden) $('controls').classList.add('hide'); }, 3500);
}

function playChannel(ch, ctx) {
  if (!state.active) return;
  state.ctx = ctx && ctx.length ? ctx : state.active.channels;
  state.ctxIndex = state.ctx.findIndex((c) => c.key === ch.key);
  const p = $('player');
  if (p.hidden) { p.hidden = false; history.pushState({ player: 1 }, ''); document.body.style.overflow = 'hidden'; }
  state.recordedThisPlay = false;
  FAV.saveLastChannel(state.active.id, ch.key);
  player.play(ch);
}

function onPlayerChannel(ch) {
  $('chName').textContent = ch.name; $('chGroup').textContent = ch.group;
  syncPlayerFav(); showControls(); renderPlayerList(); updateEpgBox();
}
function syncPlayerFav() {
  const ch = player.current; if (!ch || !state.active) return;
  $('btnFavPlayer').classList.toggle('on', FAV.isFavorite(state.active.id, ch.key));
}
function renderPlayerList() {
  const host = $('playerList'); host.replaceChildren();
  const start = Math.max(0, state.ctxIndex - 5);
  const frag = document.createDocumentFragment();
  for (const c of state.ctx.slice(start, start + 80)) frag.append(chanRow(c, state.ctx, { compact: true }));
  host.append(frag);
  const cur = host.querySelector('.current'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function updateEpgBox() {
  const box = $('epgNow'); box.replaceChildren(); box.hidden = true;
  const ch = player.current; if (!ch || !state.active || !EPG.hasEpg(state.active.id)) return;
  const nn = EPG.nowNext(state.active.id, ch); if (!nn) return;
  if (nn.now) box.append(h('div', { class: 't', text: `Ahora · ${EPG.fmtTime(nn.now.s)} – ${EPG.fmtTime(nn.now.e)}` }), h('strong', { text: nn.now.t }));
  if (nn.next) box.append(h('div', { class: 't', text: `Siguiente · ${EPG.fmtTime(nn.next.s)} – ${EPG.fmtTime(nn.next.e)}` }), h('div', { text: nn.next.t }));
  box.hidden = false;
}
setInterval(() => { if (!$('player').hidden) updateEpgBox(); }, 60000);

function step(d) {
  if (!state.ctx.length) return;
  const i = (state.ctxIndex + d + state.ctx.length) % state.ctx.length;
  playChannel(state.ctx[i], state.ctx);
}
function closePlayer(fromPop) {
  if ($('player').hidden) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  player.stop(); clearTimeout(hideTimer);
  $('player').hidden = true; document.body.style.overflow = '';
  if (!fromPop && history.state && history.state.player) history.back();
  if (['home', 'recent'].includes(state.tab)) render();
}
window.addEventListener('popstate', () => closePlayer(true));

$('btnClose').addEventListener('click', () => closePlayer(false));
$('btnRetry').addEventListener('click', () => player.retry());
$('btnPlay').addEventListener('click', () => { const v = $('video'); if (v.paused) v.play().catch(() => {}); else v.pause(); showControls(); });
$('btnPrev').addEventListener('click', () => step(-1));
$('btnNext').addEventListener('click', () => step(1));
$('btnMute').addEventListener('click', () => { const v = $('video'); v.muted = !v.muted; showControls(); });
$('volume').addEventListener('input', (e) => { const v = $('video'); v.volume = Number(e.target.value); v.muted = v.volume === 0; showControls(); });
$('btnFavPlayer').addEventListener('click', async () => {
  const ch = player.current; if (!ch) return;
  await FAV.toggleFavorite(state.active.id, ch.key); syncPlayerFav();
  const row = $('playerList').querySelector(`[data-key="${CSS.escape(ch.key)}"] .fav-btn`);
  if (row) row.classList.toggle('on', FAV.isFavorite(state.active.id, ch.key));
});
$('btnFull').addEventListener('click', async () => {
  const stage = $('playerStage');
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); }
    else {
      await (stage.requestFullscreen ? stage.requestFullscreen() : stage.webkitRequestFullscreen());
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }
  } catch { toast('Tu navegador no permite pantalla completa aquí.'); }
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch { /* noop */ } }
});
$('controls').addEventListener('click', (e) => {
  if (e.target.closest('button, input')) { showControls(); return; }
  $('controls').classList.contains('hide') ? showControls() : $('controls').classList.add('hide');
});
$('video').addEventListener('click', () => showControls());

// ---------- Búsqueda / barra superior / pestañas ----------
const doSearch = debounce(() => {
  state.query = $('searchInput').value; state.limit = PAGE;
  if (state.tab !== 'live' && state.tab !== 'favorites') state.tab = 'live';
  go(state.tab);
}, 150);
$('btnSearch').addEventListener('click', () => {
  const bar = $('searchBar'); bar.hidden = !bar.hidden;
  if (!bar.hidden) { $('searchInput').focus(); if (state.tab !== 'live' && state.tab !== 'favorites') go('live'); }
  else { $('searchInput').value = ''; state.query = ''; render(); }
});
$('searchClose').addEventListener('click', () => { $('searchBar').hidden = true; $('searchInput').value = ''; state.query = ''; render(); });
$('searchInput').addEventListener('input', doSearch);
$('btnSettings').addEventListener('click', () => go('settings'));
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));

window.addEventListener('offline', () => toast('Sin conexión a Internet'));
window.addEventListener('online', () => toast('Conexión restablecida'));
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.deferredInstall = e; if (state.tab === 'settings') render(); });

// ---------- Arranque ----------
async function init() {
  $('appName').textContent = APP_NAME; document.title = APP_NAME;
  applyTheme(prefs.get('theme', 'dark'));
  try {
    await refreshPlaylists();
    const saved = PM.getActiveId();
    const id = state.playlists.some((p) => p.id === saved) ? saved : (state.playlists[0] && state.playlists[0].id);
    await activate(id || null);
  } catch (e) {
    $('view').append(h('div', { class: 'msg err', text: 'No se pudo abrir el almacenamiento local de este navegador. La app no podrá guardar listas.' }));
  }
  requestPersistence();
  go('home');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}
init();
