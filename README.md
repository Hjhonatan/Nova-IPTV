# Nova IPTV — reproductor M3U/M3U8 (PWA)

Aplicación web progresiva, minimalista y privada, para reproducir **tu propia** lista IPTV (M3U/M3U8) desde un móvil Android.
No incluye canales ni listas, no tiene anuncios, rastreadores ni analíticas, y no envía tus datos a ningún servidor.

- HTML5 + CSS3 + JavaScript (módulos ES), sin frameworks. Reproductor HTML5 propio.
- HLS.js 1.7.4 incluido localmente en `js/vendor/` (licencia en `HLS.js-LICENSE.txt`): **no hay peticiones a CDN ni a terceros**.
- IndexedDB (listas, favoritos, historial, EPG) + localStorage (preferencias).
- Service Worker + manifest: instalable y abre sin conexión (interfaz y datos locales).

## Estructura

```
index.html            Interfaz y reproductor
manifest.webmanifest  Datos de instalación PWA
service-worker.js     Caché de recursos estáticos propios (nunca de streams/listas/logos)
css/                  styles.css · layout.css · player.css
js/config.js          Nombre de la app, versión y límites
js/m3u-parser.js      Parser M3U/EXTINF
js/playlist-manager.js Importar (archivo/URL), actualizar, renombrar, eliminar
js/player.js          Reproductor (HLS nativo / HLS.js / HTML5) y clasificación de errores
js/storage.js         IndexedDB + localStorage
js/favorites.js       Favoritos por lista, historial, último canal
js/search.js          Búsqueda, categorías, orden
js/epg.js             Guía XMLTV opcional
js/app.js             Controlador de la interfaz
test/parser.test.mjs  Pruebas del parser (node test/parser.test.mjs)
```

## Cambiar el nombre de la app

1. `js/config.js` → `APP_NAME` (interfaz y título).
2. `manifest.webmanifest` → `name` y `short_name` (nombre al instalarla).
3. `index.html` → `<title>` (opcional, se actualiza por JS).

## Ejecutar en local

Necesita servirse por HTTP(S) (los módulos y el service worker no funcionan con `file://`):

```bash
cd nova-iptv
python3 -m http.server 8080      # o: npx serve .
```

Abre `http://localhost:8080` (localhost cuenta como origen seguro para probar el service worker).

## Publicar en un alojamiento HTTPS

La instalación como PWA **exige HTTPS**. Son archivos estáticos; sirve cualquiera de estas opciones subiendo la carpeta completa:

- **GitHub Pages**: sube la carpeta a un repositorio → Settings → Pages → rama `main`, carpeta raíz.
- **Netlify / Cloudflare Pages / Vercel**: arrastra la carpeta (sin comando de build, directorio de publicación `.`).
- **Hosting propio**: copia los archivos a la raíz o a una subcarpeta (las rutas son relativas).

Si publicas una actualización, cambia `VERSION` en `service-worker.js` para que los dispositivos renueven la caché.

## Instalar en Android

1. Abre la URL HTTPS en **Chrome** (o Edge/Brave/Samsung Internet).
2. Menú ⋮ → **Instalar aplicación** (o «Añadir a la pantalla de inicio»). También puede aparecer el botón «Instalar app» en Ajustes.
3. Se abrirá a pantalla completa como una app nativa.

## Importar una lista M3U

**Por archivo:** pestaña *Listas* → «Elegir archivo .m3u / .m3u8» → selecciónalo. Se leen `#EXTINF`, `tvg-id`, `tvg-name`, `tvg-logo` y `group-title`; se indica cuántos canales se importaron. El contenido se valida (no se acepta HTML ni listas sin canales; máx. 30 MB).

**Por URL:** pestaña *Listas* → pega la dirección → «Importar desde URL». Se muestra el estado y errores claros (URL no válida, sin conexión, servidor que rechaza, CORS, formato inválido). Puedes añadir varias listas, renombrarlas, cambiar la activa, actualizar las remotas y eliminarlas (con confirmación). **Si una actualización falla, tu lista anterior se conserva intacta.** Los favoritos y el historial son independientes por lista.

> Las URL con usuario/contraseña/token se guardan localmente para poder actualizar la lista, pero nunca se muestran completas en pantalla ni en mensajes de error.

## Configurar la EPG (opcional)

*Ajustes → Guía* → pega la URL de un archivo XMLTV (`.xml`) → «Importar guía». Se asocia por `tvg-id` (o por nombre) y se muestra «Ahora / Siguiente» con horarios en la lista y en el reproductor. Solo se guarda una ventana de ~2 días. Sin guía configurada no se muestra ninguna programación. Se actualiza manualmente con «Actualizar guía». Requiere que el servidor de la guía permita CORS.

## Privacidad

Todo se guarda en tu dispositivo. Si borras los datos del navegador o desinstalas la app, **se pierden listas, favoritos e historial**. No hay analíticas ni registro de usuarios. Los nombres, logos y metadatos de la lista se tratan como datos no confiables: se muestran siempre como texto, solo se admiten logos `http(s)`, no se ejecuta nada de la lista y no hay proxies. La política CSP de `index.html` bloquea scripts de terceros.

## Pruebas realizadas

Automáticas (en este entorno):

- Sintaxis de todos los módulos y validez del manifest. ✔
- Parser (`node test/parser.test.mjs`): metadatos, comas dentro de comillas, canales sin grupo → «Sin categoría», logos `javascript:` descartados, HTML/vacío/sin canales rechazados, 50.000 canales en ~0,3 s. ✔
- Navegador headless (Chromium, viewport 390×780): estado vacío sin contenido ficticio, importar archivo M3U, interpretación de canales y categorías, búsqueda, favoritos persistentes tras recargar, error de reproducción comprensible con «Reintentar» y detalles técnicos, registro del service worker, **cero peticiones a dominios externos** (aparte del canal pedido). ✔

**Pendientes de verificar por ti en tu teléfono y tu lista** (no se pueden comprobar sin dispositivo ni transmisiones autorizadas):

- Abrir e instalar en Android (Chrome).
- Reproducción con tus canales y pantalla completa horizontal.
- Importar por URL real (depende de CORS, ver abajo).
- Apertura sin conexión tras la primera carga (se espera que cargue la interfaz y los datos locales).

## Limitaciones conocidas

- **CORS:** un navegador solo puede descargar una lista/guía por URL si el servidor lo permite. Si no, la app lo indica; usa el método por archivo o una fuente compatible / un proxy **propio y autorizado** (la app no incluye ningún proxy).
- **Contenido mixto:** desde HTTPS el navegador bloquea listas y canales `http://`. La app lo detecta y lo explica; necesitas fuentes `https://`.
- **Formatos:** solo HLS (`.m3u8`) y formatos que HTML5 reproduzca (p. ej. MP4/WebM, según navegador). **No** se reproducen `rtmp://`, `rtsp://`, `udp://` ni flujos MPEG-TS crudos (`.ts` directo) en un navegador; esas entradas se ignoran o fallarán.
- Los **canales de pago o con DRM** y los servidores que exigen cabeceras especiales (User-Agent, Referer) pueden no funcionar en el navegador.
- Muchos servidores IPTV bloquean la reproducción desde un origen web (CORS en los segmentos de vídeo); el error se mostrará como de red/no disponible.
- Los navegadores usan un mismo código de error para «canal caído» y «formato no soportado» en reproducción nativa, por lo que a veces el mensaje cubre ambas posibilidades.
- **Orientación:** el bloqueo horizontal solo funciona en pantalla completa y si el navegador lo permite.
- **Sin conexión** se abre la interfaz y los datos guardados, pero **no se reproducen canales**; las transmisiones nunca se guardan en caché.
- Las acciones de actualización son manuales; la app no comprueba la disponibilidad de los canales en segundo plano para ahorrar batería y datos.

## Uso responsable

Usa únicamente listas y transmisiones a las que tengas derecho legal de acceso. Esta app es un reproductor genérico y no proporciona ni elude restricciones de acceso o licencias.
