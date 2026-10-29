import { parseM3U } from '../js/m3u-parser.js';
import assert from 'node:assert/strict';

const sample = `#EXTM3U
#EXTINF:-1 tvg-id="a.es" tvg-name="Canal A" tvg-logo="https://x.test/a.png" group-title="Noticias, Local",Canal A <b>HD</b>
https://s.test/a.m3u8
#EXTINF:-1,Canal B
#EXTVLCOPT:http-user-agent=x
https://s.test/b.m3u8?token=abc
#EXTINF:-1 group-title="Cine",Canal C
rtmp://s.test/c
#EXTINF:-1 tvg-logo="javascript:alert(1)",Canal D
http://s.test/d.ts
`;
const r = parseM3U(sample);
assert.equal(r.channels.length, 3);
assert.equal(r.skipped, 1);
assert.equal(r.channels[0].group, 'Noticias, Local');   // coma dentro de comillas
assert.equal(r.channels[0].name, 'Canal A <b>HD</b>');  // se conserva como texto (se muestra con textContent)
assert.equal(r.channels[0].logo, 'https://x.test/a.png');
assert.equal(r.channels[1].group, 'Sin categoría');
assert.equal(r.channels[2].logo, '');                    // esquema javascript: descartado
assert.notEqual(r.channels[0].key, r.channels[1].key);

for (const bad of ['', '   ', '<!doctype html><html></html>', 'hola mundo', '#EXTM3U\n#EXTINF:-1,X\nftp://x']) {
  assert.throws(() => parseM3U(bad), (e) => ['EMPTY', 'INVALID'].includes(e.code), 'debe rechazar: ' + JSON.stringify(bad));
}
// Lista grande
let big = '#EXTM3U\n'; for (let i = 0; i < 50000; i++) big += `#EXTINF:-1 group-title="G${i%50}",Canal ${i}\nhttps://s.test/${i}.m3u8\n`;
const t = Date.now(); const rb = parseM3U(big);
assert.equal(rb.channels.length, 50000);
console.log('50.000 canales parseados en', Date.now() - t, 'ms');
console.log('parser: todas las pruebas OK');
