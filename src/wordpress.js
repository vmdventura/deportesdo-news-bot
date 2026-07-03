const BASE_URL = () => `${process.env.WORDPRESS_URL}/wp-json/wp/v2`;
const authHeader = () =>
  'Basic ' + Buffer.from(`${process.env.WORDPRESS_USERNAME}:${process.env.WORDPRESS_APP_PASSWORD}`).toString('base64');

async function wpFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL()}${path}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      ...options.headers,
    },
  });

  let body;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  if (!res.ok) {
    const message = body?.message || body?.code || JSON.stringify(body);
    throw new Error(`WordPress API error ${res.status}: ${message}`);
  }

  return body;
}

export async function uploadImage(buffer, filename, mimeType = 'image/jpeg', altText = '') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  if (altText) {
    form.append('alt_text', altText);
    form.append('title', altText);
  }

  const data = await wpFetch('/media', {
    method: 'POST',
    body: form,
  });

  return { id: data.id, url: data.source_url };
}

// Busca cada etiqueta por nombre; si no existe la crea. Devuelve los term IDs.
// El rol Editor tiene manage_categories, así que puede crear etiquetas.
export async function ensureTags(names = []) {
  // Claude a veces devuelve las etiquetas como string ("España, Mundial")
  // en vez de array; iterar un string da caracteres sueltos como tags.
  const list = (Array.isArray(names) ? names : String(names).split(','))
    .map(n => String(n).trim())
    .filter(n => n.length > 1)
    .slice(0, 6);

  const ids = [];
  for (const clean of list) {
    try {
      const found = await wpFetch(`/tags?search=${encodeURIComponent(clean)}&per_page=20`);
      const match = found.find(t => t.name.toLowerCase() === clean.toLowerCase());
      if (match) {
        ids.push(match.id);
        continue;
      }
      const created = await wpFetch('/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean }),
      });
      ids.push(created.id);
    } catch {
      // Etiqueta conflictiva (slug duplicado, etc.) — el post sale sin ella.
    }
  }
  return ids;
}

export async function getCurrentUser() {
  return wpFetch('/users/me?context=edit');
}

// Mapa slug → { id, name, tier } de la taxonomía 'deporte' (las 59+ federaciones).
// Endpoint público del plugin deportesdo-core; sin él el post se rechaza con 422 al publicar.
export async function getTaxonomyMap() {
  const res = await fetch(`${process.env.WORDPRESS_URL}/wp-json/deportesdo/v1/taxonomy-map`);
  if (!res.ok) throw new Error(`No se pudo obtener el taxonomy-map (HTTP ${res.status})`);
  const data = await res.json();
  return data.deporte || {};
}

// Categoría nativa de WP cuyo slug coincide con el deporte (beisbol, boxeo, futbol…).
// Endpoint público. Devuelve null si no existe categoría con ese slug.
export async function getCategoryIdBySlug(slug) {
  if (!slug) return null;
  const res = await fetch(`${process.env.WORDPRESS_URL}/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) return null;
  const cats = await res.json();
  return cats[0]?.id ?? null;
}

const TITLE_MAX = 70; // deportesdo-core rechaza con 422 títulos de más de 70 caracteres

function capTitle(title) {
  if (title.length <= TITLE_MAX) return title;
  return `${title.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '')}…`;
}

// Espaciado entre publicaciones: si el bot procesa varias noticias seguidas,
// no queremos que todas salgan con el mismo timestamp (se ve mal en el home
// y no aporta a la señal de "contenido fresco" para SEO). nextSlot se
// resetea con cada reinicio del proceso — solo espacia dentro de la sesión.
const PUBLISH_SPACING_MINUTES = 20;
const MIN_DELAY_MS = 60_000; // por debajo de esto, publicar de una vez
let nextSlot = 0;

export async function createPost({ title, html, excerpt, slug, focus_keyword, meta_description, mediaId, deporteId, categoryId, tagIds }) {
  const safeTitle = capTitle(title);

  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  const shouldSchedule = slot - now > MIN_DELAY_MS;
  nextSlot = slot + PUBLISH_SPACING_MINUTES * 60_000;

  const payload = {
    title: safeTitle,
    content: html,
    excerpt,
    slug,
    featured_media: mediaId,
    ...(deporteId ? { deporte: [deporteId] } : {}),
    ...(categoryId ? { categories: [categoryId] } : {}),
    ...(tagIds?.length ? { tags: tagIds } : {}),
    ...(shouldSchedule ? { date_gmt: new Date(slot).toISOString() } : {}),
    meta: {
      rank_math_focus_keyword: focus_keyword,
      rank_math_description: meta_description,
      rank_math_title: `${safeTitle} | DeportesDo`,
    },
  };

  const post = status =>
    wpFetch('/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, status }),
    });

  try {
    const data = await post(shouldSchedule ? 'future' : 'publish');
    return {
      id: data.id,
      url: data.link,
      status: shouldSchedule ? 'future' : 'publish',
      scheduledFor: shouldSchedule ? new Date(slot) : null,
    };
  } catch (err) {
    if (!/WordPress API error 40[13]/.test(err.message)) throw err;

    // El usuario no tiene permiso de publicar; intenta guardar como borrador
    // para no perder la noticia ya redactada.
    try {
      const data = await post('draft');
      return { id: data.id, url: data.link, status: 'draft', scheduledFor: null };
    } catch {
      const who = await getCurrentUser().catch(() => null);
      const role = who?.roles?.join(', ') || 'desconocido';
      throw new Error(
        `El usuario de WordPress no tiene permiso para crear entradas (rol actual: ${role}). ` +
        `Verifica en wp-admin > Usuarios que el rol sea Autor o superior.`
      );
    }
  }
}
