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

export async function scrapeArticle(url) {
  // Algunos sitios (ESPN) detectan el UA de navegador falso y responden
  // 202 con cuerpo vacío, pero sirven el HTML completo a un bot honesto.
  let { status, html } = await fetchHtml(url, UA_BROWSER);
  if (status !== 200 || html.length < 2000) {
    ({ status, html } = await fetchHtml(url, UA_BOT));
  }
  if (status !== 200) throw new Error(`HTTP ${status} al acceder a ${url}`);

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
  let text = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    if (text.length >= 200) return;
    try {
      const data = JSON.parse($(el).html() || '{}');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const body = item.articleBody || item.description || '';
        if (body.length > text.length) text = body;
      }
    } catch { /* invalid JSON, skip */ }
  });

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

  text = text.slice(0, 8000);

  if (!title || text.length < 100) {
    throw new Error('No se pudo extraer contenido suficiente de la URL. Intenta con una URL diferente o copia el texto del artículo.');
  }

  return { title, text, imageUrl };
}
