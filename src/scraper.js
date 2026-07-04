import * as cheerio from 'cheerio';

const TIMEOUT_MS = 10_000;

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const UA_BOT = 'DeportesDOBot/1.0 (+https://deportesdo.com)';

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

const UA_CURL = 'curl/8.6.0';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export async function scrapeArticle(url) {
  // Cascada de User-Agents: algunos sitios (ESPN) responden 202 con cuerpo
  // vacío al UA de navegador falso pero sirven el HTML completo a bots
  // honestos — y desde IPs de datacenter (GitHub Actions) el bloqueo es más
  // agresivo que desde una IP residencial. Se prueban varios UAs y una
  // segunda ronda con pausa antes de rendirse.
  const uas = [UA_BROWSER, UA_BOT, UA_CURL, UA_GOOGLEBOT];
  let status = 0, html = '';
  outer: for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, 1500));
    for (const ua of uas) {
      let res;
      try { res = await fetchHtml(url, ua); } catch { continue; }
      if (res.html.length > html.length || !status) ({ status, html } = res);
      if ((res.status === 200 || res.status === 202) && res.html.length >= 2000) break outer;
    }
  }
  if (status !== 200 && html.length < 2000) throw new Error(`HTTP ${status} al acceder a ${url}`);

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

  // 1. Try JSON-LD structured data (works on ESPN, AP, Reuters, etc.)
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

  // 2. Fallback: scrape visible text from the DOM
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

  text = text.slice(0, 8000);

  if (!title || text.length < 100) {
    throw new Error('No se pudo extraer contenido suficiente de la URL. Intenta con una URL diferente o copia el texto del artículo.');
  }

  return { title, text, imageUrl };
}
