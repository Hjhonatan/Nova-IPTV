// Búsqueda, filtro por categoría y orden sobre la lista de canales activa.
import { normalize } from './m3u-parser.js';

export function categoriesOf(channels) {
  const map = new Map();
  for (const c of channels) map.set(c.group, (map.get(c.group) || 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter((c) => c.count > 0) // ocultar categorías vacías
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export function filterChannels(channels, { query = '', category = '', sort = 'list', onlyKeys = null } = {}) {
  const q = normalize(query.trim());
  let out = channels;
  if (category) out = out.filter((c) => c.group === category);
  if (onlyKeys) out = out.filter((c) => onlyKeys.has(c.key));
  if (q) out = out.filter((c) => c.searchName.includes(q));
  if (sort === 'az') out = [...out].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  return out;
}

export function debounce(fn, ms = 150) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
