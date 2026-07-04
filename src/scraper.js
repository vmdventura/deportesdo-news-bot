import * as cheerio from 'cheerio';

const TIMEOUT_MS = 10_000;

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const UA_BOT = 'DeportesDOBot/1.0 (+https://deportesdo.com)';
const UA_CURL = 'curl/8.6.0';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

async function fetchHtml(url, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    });
    return { status: res.status, html: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// Extrae título/texto/imagen de un HTML ya descargado. Devuelve siempre un
// candidato (posiblemente vacío) — el llamador decide si es suficiente.
function extractFromHtml(html) {
  const $ = cheerio.load(html);

  const title =
    ($('meta[property="og:title"]').attr('content') || '').trim() ||
    ($('meta[name="twitter:title"]').attr('content') || '').trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim();

  const imageUrl =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    null;

  // 1. JSON-LD estructurado (ESPN, AP, Reuters, LIDOM, etc.)
  // articleBody es contenido real y completo; description es apenas un
  // teaser corto (150-300 caracteres, pensado para SEO/redes) que a veces
  // pasa cualquier umbral sin ser ni de lejos el artículo completo (caso
  // real: MLB.com trae description pero NUNCA articleBody). Por eso solo
  // articleBody puede evitar el respaldo por DOM — description queda como
  // último recurso, después de intentar el DOM.
  let articleBody = '';
  let description = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '{}');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item.articleBody?.length > articleBody.length) articleBody = item.articleBody;
        if (item.description?.length > description.length) description = item.description;
      }
    } catch { /* invalid JSON, skip */ }
  });

  let text = articleBody;

  // 2. Respaldo: texto visible del DOM
  if (text.length < 200) {
    $('script, style, nav, header, footer, aside, .ad, .advertisement, [class*="sidebar"], [id*="sidebar"], [class*="menu"], [class*="related"], [class*="comment"], [class*="newsletter"], [class*="subscribe"]').remove();

    const selectors = [
      '[itemprop="articleBody"]',
      '[class*="article-body"]',
      '[class*="story-body"]',
      '[class*="article__body"]',
      '[class*="entry-content"]',
      '[class*="post-content"]',
      'article',
      'main',
      '[class*="content"]',
      'body',
    ];

    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length) {
        const candidate = el.text().replace(/\s+/g, ' ').trim();
        if (candidate.length > text.length) text = candidate;
        if (text.length >= 300) break;
      }
    }
  }

  // Último recurso: el teaser corto es mejor que nada si ni articleBody ni
  // el DOM dieron suficiente.
  if (description.length > text.length) text = description;

  return { title, text: text.slice(0, 8000), imageUrl };
}

export async function scrapeArticle(url) {
  // Cascada de User-Agents × 2 rondas con pausa. El éxito NO se mide en bytes
  // recibidos sino en TEXTO EXTRAÍDO: una página-desafío anti-bot puede pesar
  // miles de caracteres de JavaScript sin traer ni un párrafo del artículo
  // (caso real: ESPN desde IPs de GitHub Actions). Cada respuesta se intenta
  // extraer y solo cuenta como éxito si produce contenido de verdad.
  const uas = [UA_BROWSER, UA_BOT, UA_CURL, UA_GOOGLEBOT];
  let best = null;
  for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, 1500));
    for (const ua of uas) {
      let res;
      try { res = await fetchHtml(url, ua); } catch { continue; }
      if (res.html.length < 500) continue;
      const cand = extractFromHtml(res.html);
      if (cand.title && cand.text.length >= 300) return cand;
      if (!best || cand.text.length > best.text.length) best = cand;
    }
  }
  if (best && best.title && best.text.length >= 100) return best;
  throw new Error('No se pudo extraer contenido suficiente de la URL. Intenta con una URL diferente o copia el texto del artículo.');
}
