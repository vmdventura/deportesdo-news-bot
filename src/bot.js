import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { scrapeArticle } from './scraper.js';
import { rewriteArticle } from './claude.js';
import { uploadImage, createPost, getTaxonomyMap, getCategoryIdBySlug, ensureTags } from './wordpress.js';
import { getTrendingBrief } from './trends.js';

function escapeAttr(s = '') {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Inserta la foto (con alt = keyword) tras el primer párrafo, y añade al
// final el enlace interno al archivo del deporte. Rank Math puntúa: imagen
// con keyword en alt y enlace interno. Sin crédito externo a la fuente
// (no le regalamos enlace/autoridad a la competencia).
function buildContent({ html, imageAlt, mediaUrl, deporteNombre, deporteSlug }) {
  let out = html;
  const figure = `<figure class="wp-block-image size-large"><img src="${escapeAttr(mediaUrl)}" alt="${escapeAttr(imageAlt)}"/></figure>`;
  const firstP = out.indexOf('</p>');
  out = firstP >= 0
    ? `${out.slice(0, firstP + 4)}\n${figure}\n${out.slice(firstP + 4)}`
    : `${figure}\n${out}`;

  const siteUrl = (process.env.WORDPRESS_URL || '').replace(/\/$/, '');
  out += `\n<p><em>Más noticias de ${escapeAttr(deporteNombre)} en <a href="${siteUrl}/deporte/${escapeAttr(deporteSlug)}/">DeportesDO</a>.</em></p>`;
  return out;
}

// handlerTimeout por defecto de Telegraf (90s) se queda corto: el bot puede
// hacer hasta 3 intentos de redacción con Claude para cumplir el SEO, más
// scraping e imagen — todo eso junto puede pasar de los 90s fácilmente.
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 600_000 });

// Red de seguridad: sin esto, cualquier error no capturado (incluido un
// timeout de Telegraf) tumba TODO el proceso — el bot deja de responder
// hasta que alguien lo reinicie a mano. Con esto, el bot loguea y sigue vivo.
bot.catch((err, ctx) => {
  console.error('Error no capturado en el bot:', err.message);
  ctx.reply(`Error interno del bot:\n${err.message}`).catch(() => {});
});

const ALLOWED_USERS = new Set(
  (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map(id => id.trim()).filter(Boolean)
);

// In-memory session store: userId → { state, url }
const sessions = new Map();

const URL_REGEX = /https?:\/\/[^\s]+/i;

function isAllowed(ctx) {
  return ALLOWED_USERS.size === 0 || ALLOWED_USERS.has(String(ctx.from.id));
}

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { state: 'IDLE', url: null });
  return sessions.get(userId);
}

// Continúa el pipeline una vez que ya tenemos texto del artículo — sea por
// scraping automático o porque el usuario lo pegó a mano (sitios con todo
// el contenido en JavaScript, como DAZN, no dejan nada que leer en el HTML).
async function processArticleCore(ctx, { url, title, text, photoFileId }) {
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  session.state = 'PROCESSING';

  const status = await ctx.reply('Procesando noticia... esto puede tardar unos segundos.');

  try {
    // 2. Rewrite with Claude Sonnet — con la lista real de deportes del sitio
    // (deportesdo-core exige la taxonomía 'deporte' para publicar; sin ella → 422)
    const taxonomyMap = await getTaxonomyMap().catch(() => ({}));
    const deporteSlugs = Object.keys(taxonomyMap);
    const article = await rewriteArticle({ title, text, sourceUrl: url, deporteSlugs });
    const deporteId = taxonomyMap[article.deporte_slug]?.id;

    // Categoría nativa de WP con el mismo slug del deporte; si no existe, Multideporte
    const categoryId =
      (await getCategoryIdBySlug(article.deporte_slug).catch(() => null)) ||
      (await getCategoryIdBySlug('multideporte').catch(() => null));

    // 3. Download photo from Telegram
    const fileLink = await ctx.telegram.getFileLink(photoFileId);
    const imgRes = await fetch(fileLink.href);
    if (!imgRes.ok) throw new Error('No se pudo descargar la foto de Telegram.');
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
    const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';

    // 4. Upload image to WordPress (con alt = keyword para Rank Math)
    const imageAlt = article.image_alt || article.focus_keyword;
    const media = await uploadImage(imgBuffer, `noticia-${Date.now()}.${ext}`, mimeType, imageAlt);

    // 5. Etiquetas: buscar o crear cada una
    const tagIds = await ensureTags(article.tags || []).catch(() => []);

    // 6. Contenido final: foto dentro del artículo + enlaces fuente/interno
    const deporteNombre = taxonomyMap[article.deporte_slug]?.name || article.deporte_slug;
    const finalHtml = buildContent({
      html: article.html,
      imageAlt,
      mediaUrl: media.url,
      deporteNombre,
      deporteSlug: article.deporte_slug,
    });

    // 7. Create and publish post — espaciado automático si hay cola (ver createPost)
    const { url: postUrl, status: postStatus, scheduledFor } = await createPost({
      ...article,
      html: finalHtml,
      mediaId: media.id,
      deporteId,
      categoryId,
      tagIds,
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    const tagsInfo = tagIds.length ? ` · ${tagIds.length} etiquetas` : '';
    if (postStatus === 'publish') {
      await ctx.reply(`Noticia publicada exitosamente (${deporteNombre}${tagsInfo}):\n${postUrl}`);
    } else if (postStatus === 'future') {
      const hora = scheduledFor.toLocaleTimeString('es-DO', { timeZone: 'America/Santo_Domingo', hour: '2-digit', minute: '2-digit' });
      await ctx.reply(
        `Noticia programada para las ${hora} (${deporteNombre}${tagsInfo}) — para no amontonar publicaciones seguidas:\n${postUrl}`
      );
    } else {
      await ctx.reply(
        `La noticia se guardó como borrador (WordPress rechazó la publicación directa):\n${postUrl}\n\n` +
        `Revísala y publícala desde wp-admin. Si esto pasa siempre, verifica el rol del usuario y que el post tenga deporte e imagen destacada.`
      );
    }
  } catch (err) {
    console.error(`Error procesando ${url}:`, err.message);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await ctx.reply(`Error al procesar la noticia:\n${err.message}`);
  } finally {
    session.state = 'IDLE';
    session.url = null;
  }
}

// Intenta leer la URL automáticamente. Si el sitio no sirve contenido
// estático (ej. DAZN, apps 100% en React) o bloquea el scraping, en vez de
// fallar le pide al usuario que pegue el texto del artículo a mano.
async function processArticle(ctx, url, photoFileId) {
  const userId = String(ctx.from.id);
  const session = getSession(userId);

  let title, text;
  try {
    ({ title, text } = await scrapeArticle(url));
  } catch (err) {
    session.state = 'WAITING_TEXT_FALLBACK';
    session.pendingUrl = url;
    session.pendingPhotoFileId = photoFileId;
    await ctx.reply(
      `No pude leer ese artículo automáticamente (${err.message}).\n\n` +
      `Copia y pega aquí el texto completo de la noticia y continúo con eso. O /cancelar.`
    );
    return;
  }

  await processArticleCore(ctx, { url, title, text, photoFileId });
}

// Auth middleware
bot.use((ctx, next) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  return next();
});

bot.command('start', ctx => {
  const session = getSession(String(ctx.from.id));
  session.state = 'IDLE';
  session.url = null;
  session.pendingUrl = null;
  session.pendingPhotoFileId = null;
  ctx.reply(
    'Bienvenido al bot de noticias de DeportesDo.com.\n\n' +
    'Uso:\n' +
    '1. Envia /noticia [URL] o simplemente pega una URL\n' +
    '2. Luego envia la foto para la noticia\n' +
    '   (o envia la foto con la URL en el caption)\n\n' +
    'Si envías varias noticias seguidas, la primera se publica de inmediato y las siguientes se programan automáticamente (mínimo 20 min entre sí) para no amontonar publicaciones en el mismo horario.\n\n' +
    '/tendencias — qué está sonando ahora en RD (Twitter/X + Google)\n' +
    '/cancelar — cancela la operacion actual'
  );
});

bot.command('cancelar', ctx => {
  const session = getSession(String(ctx.from.id));
  session.state = 'IDLE';
  session.url = null;
  ctx.reply('Operacion cancelada.');
});

bot.command('tendencias', async ctx => {
  const status = await ctx.reply('Buscando tendencias en RD (Twitter/X + Google)...');
  try {
    const { topics, twitterOk, googleOk } = await getTrendingBrief();
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

    if (!topics.length) {
      return ctx.reply('No se pudieron obtener tendencias ahora mismo. Intenta de nuevo en unos minutos.');
    }

    const lines = topics.map((t, i) => {
      const cruzado = t.crossed ? ' — también suena en Twitter/X' : '';
      const trafico = t.traffic ? ` (${t.traffic} búsquedas)` : '';
      return `${i + 1}. ${t.title}${trafico}${cruzado}`;
    });

    const avisos = [];
    if (!twitterOk) avisos.push('Twitter/X no respondió esta vez');
    if (!googleOk) avisos.push('Google Trends no respondió esta vez');

    await ctx.reply(
      `Tendencias en RD ahora mismo:\n\n${lines.join('\n')}\n\n` +
      `Los marcados "también suena en Twitter/X" tienen doble señal: se buscan y se comentan al mismo tiempo — prioridad alta.\n\n` +
      `Envía la URL de un artículo sobre alguno de estos temas para redactarlo.` +
      (avisos.length ? `\n\n(${avisos.join('; ')}.)` : '')
    );
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await ctx.reply(`Error al buscar tendencias:\n${err.message}`);
  }
});

bot.command('noticia', ctx => {
  const session = getSession(String(ctx.from.id));
  if (session.state === 'PROCESSING') return ctx.reply('Ya estoy procesando una noticia. Espera un momento.');

  const urlMatch = ctx.message.text.match(URL_REGEX);
  if (!urlMatch) return ctx.reply('Uso: /noticia [URL]\nEjemplo: /noticia https://espn.com/deportes/...');

  session.url = urlMatch[0];
  session.state = 'WAITING_PHOTO';
  ctx.reply('URL guardada. Ahora envia la foto para la noticia.');
});

// Handle plain text messages — detect URLs, o texto pegado a mano si el
// scraping automático falló (ver processArticle)
bot.on('text', ctx => {
  const session = getSession(String(ctx.from.id));
  if (session.state === 'PROCESSING') return ctx.reply('Ya estoy procesando una noticia. Espera.');

  if (session.state === 'WAITING_TEXT_FALLBACK') {
    const pastedText = ctx.message.text.trim();
    // Si en vez del texto llega una URL, el usuario quiere empezar una
    // noticia nueva — salir del modo "pegar texto" y tratarla como URL.
    const fallbackUrl = pastedText.match(URL_REGEX)?.[0];
    if (fallbackUrl && pastedText.length < 300) {
      session.state = 'WAITING_PHOTO';
      session.url = fallbackUrl;
      session.pendingUrl = null;
      session.pendingPhotoFileId = null;
      return ctx.reply('URL guardada. Ahora envia la foto para la noticia.');
    }
    if (pastedText.length < 100) {
      return ctx.reply('Ese texto es muy corto para redactar el artículo. Pega el texto completo de la noticia que te pedí, o /cancelar. (Si quieres empezar con otra noticia, simplemente envía su URL.)');
    }
    const { pendingUrl, pendingPhotoFileId } = session;
    session.state = 'IDLE';
    processArticleCore(ctx, { url: pendingUrl, title: '', text: pastedText, photoFileId: pendingPhotoFileId });
    return;
  }

  const urlMatch = ctx.message.text.match(URL_REGEX);
  if (!urlMatch) {
    if (session.state === 'WAITING_PHOTO') return ctx.reply('Envia la foto para continuar, o /cancelar para salir.');
    return;
  }

  session.url = urlMatch[0];
  session.state = 'WAITING_PHOTO';
  ctx.reply('URL guardada. Ahora envia la foto para la noticia.');
});

// Handle photos
bot.on('photo', async ctx => {
  const session = getSession(String(ctx.from.id));
  if (session.state === 'PROCESSING') return ctx.reply('Ya estoy procesando una noticia. Espera.');

  // Photo with URL in caption counts as a single-message submission
  const caption = ctx.message.caption || '';
  const captionUrl = caption.match(URL_REGEX)?.[0];

  const url = captionUrl || session.url;
  if (!url) return ctx.reply('Primero envia la URL del articulo, luego la foto.');

  // Highest resolution photo
  const photos = ctx.message.photo;
  const best = photos[photos.length - 1];

  await processArticle(ctx, url, best.file_id);
});

bot.launch();
console.log('Bot iniciado correctamente.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
