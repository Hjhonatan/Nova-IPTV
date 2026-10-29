// Reproductor HTML5 personalizado con HLS.js (carga diferida) y HLS nativo cuando existe.
// Solo hay un <video> y una instancia de Hls a la vez; se destruye al cambiar de canal.
import { redactUrl } from './playlist-manager.js';

let hlsLoading = null;
function loadHlsLib() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLoading) return hlsLoading;
  hlsLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/hls.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsLoading = null; reject(new Error('No se pudo cargar HLS.js')); };
    document.head.appendChild(s);
  });
  return hlsLoading;
}

const looksHls = (u) => /\.m3u8(\?|#|$)/i.test(u) || /m3u8/i.test(u);

export function classifyError(kind, info = {}) {
  // kind: 'mixed' | 'offline' | 'hls-network' | 'hls-media' | 'native' | 'timeout' | 'unsupported-proto'
  const code = info.status;
  if (kind === 'mixed') return { type: 'MIXED', msg: 'El navegador bloquea este canal porque usa http:// y la app se sirve por HTTPS. Necesitas una lista con direcciones https://.' };
  if (kind === 'offline') return { type: 'OFFLINE', msg: 'No hay conexión a Internet.' };
  if (kind === 'timeout') return { type: 'TIMEOUT', msg: 'El canal tarda demasiado en responder. Puede estar caído o saturado.' };
  if (code === 401 || code === 403) return { type: 'ACCESS', msg: 'El servidor rechazó el acceso a este canal (puede requerir una cuenta activa o estar restringido).' };
  if (code === 404 || code === 410) return { type: 'UNAVAILABLE', msg: 'El canal no está disponible en este momento.' };
  if (kind === 'native' && info.nativeCode === 4) {
    // Los navegadores usan este código tanto para formatos no soportados como para canales caídos o bloqueados.
    return { type: 'UNAVAILABLE_OR_FORMAT', msg: 'No se pudo cargar el canal. Puede estar caído, bloqueado, o usar un formato que este navegador no reproduce.' };
  }
  if (kind === 'hls-media' || (kind === 'native' && info.nativeCode === 3)) {
    return { type: 'FORMAT', msg: 'El formato de vídeo de este canal no es compatible con el navegador.' };
  }
  if (kind === 'hls-network' || (kind === 'native' && info.nativeCode === 2)) {
    return { type: 'NETWORK', msg: 'Error de red al cargar el canal. Puede estar caído, bloqueado por CORS o tu conexión puede ser inestable.' };
  }
  return { type: 'UNKNOWN', msg: 'No se pudo reproducir este canal.' };
}

export function createPlayer(els, hooks = {}) {
  const { video, wrap, spinner, errorBox, errorMsg, errorDetailBtn, errorDetail } = els;
  let hls = null;
  let current = null;
  let triedHlsFallback = false;
  let startTimer = null;
  let lastDetail = '';
  let activeUrl = '';
  let upgraded = false; // true si se cambió http:// por https:// para este intento

  function setLoading(on) { spinner.hidden = !on; }
  function showError(err, detail) {
    setLoading(false);
    errorMsg.textContent = err.msg + (upgraded ? ' (La app probó la versión https:// de este canal; es probable que su servidor no la admita.)' : '');
    lastDetail = detail || '';
    errorDetail.textContent = lastDetail;
    errorDetail.hidden = true;
    errorDetailBtn.hidden = !lastDetail;
    errorBox.hidden = false;
    hooks.onError && hooks.onError(err);
  }
  function hideError() { errorBox.hidden = true; }

  function release() {
    clearTimeout(startTimer);
    if (hls) { try { hls.destroy(); } catch { /* noop */ } hls = null; }
    try { video.pause(); } catch { /* noop */ }
    video.removeAttribute('src');
    video.load(); // libera el búfer y la conexión
  }

  function armTimeout() {
    clearTimeout(startTimer);
    startTimer = setTimeout(() => {
      if (video.readyState < 3) showError(classifyError('timeout'), 'Sin datos tras 25 s · ' + redactUrl(current.url));
    }, 25000);
  }

  async function startHls(url) {
    const Hls = await loadHlsLib().catch(() => null);
    if (!current || activeUrl !== url) return;
    if (Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20, backBufferLength: 10, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2 });
      let netRecoveries = 0; let mediaRecoveries = 0;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        const status = data.response && data.response.code;
        const d = `${data.type}/${data.details}${status ? ' · HTTP ' + status : ''} · ${redactUrl(url)}`;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !status && netRecoveries < 1 && data.details !== 'manifestLoadError') {
          netRecoveries++; hls.startLoad(); return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
          mediaRecoveries++; hls.recoverMediaError(); return;
        }
        const kind = data.type === Hls.ErrorTypes.MEDIA_ERROR ? 'hls-media' : 'hls-network';
        release();
        showError(classifyError(kind, { status }), d);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url; video.play().catch(() => {});
    } else {
      showError({ type: 'FORMAT', msg: 'Este navegador no puede reproducir transmisiones HLS.' }, 'HLS no soportado');
    }
  }

  async function play(channel) {
    if (!channel) return;
    release();
    hideError();
    current = channel;
    triedHlsFallback = false;
    setLoading(true);
    hooks.onChannel && hooks.onChannel(channel);

    if (!navigator.onLine) return showError(classifyError('offline'));
    let url = channel.url;
    upgraded = false;
    if (location.protocol === 'https:' && /^http:/i.test(url)) {
      if (hooks.getUpgradeHttp && hooks.getUpgradeHttp()) {
        url = url.replace(/^http:/i, 'https:');
        upgraded = true;
      } else {
        return showError(classifyError('mixed'), 'Contenido mixto bloqueado · ' + redactUrl(url));
      }
    }
    activeUrl = url;
    armTimeout();
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
    if (looksHls(url) && !nativeHls) {
      await startHls(url);
    } else {
      video.src = url; // HLS nativo o archivo/stream directo compatible con HTML5
      video.play().catch(() => {});
    }
  }

  function retry() { if (current) play(current); }
  function stop() { release(); current = null; setLoading(false); hideError(); }

  video.addEventListener('waiting', () => setLoading(true));
  video.addEventListener('stalled', () => { if (!video.paused) setLoading(true); });
  video.addEventListener('playing', () => { clearTimeout(startTimer); setLoading(false); hideError(); hooks.onState && hooks.onState('playing'); });
  video.addEventListener('canplay', () => { setLoading(false); });
  video.addEventListener('pause', () => hooks.onState && hooks.onState('paused'));
  video.addEventListener('volumechange', () => hooks.onVolume && hooks.onVolume(video));
  video.addEventListener('error', () => {
    if (!current) return;
    const code = video.error ? video.error.code : 0;
    // Si un enlace sin extensión falla como "no soportado", se intenta una vez como HLS.
    if (code === 4 && !triedHlsFallback && !looksHls(current.url)) {
      triedHlsFallback = true;
      video.removeAttribute('src'); video.load();
      startHls(activeUrl);
      return;
    }
    release();
    showError(classifyError('native', { nativeCode: code }), `MediaError ${code} · ${redactUrl(current.url)}`);
  });
  errorDetailBtn.addEventListener('click', () => { errorDetail.hidden = !errorDetail.hidden; });

  return { play, stop, retry, get current() { return current; }, video };
}
