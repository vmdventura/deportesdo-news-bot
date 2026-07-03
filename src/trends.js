import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Trending topics reales de Twitter/X en RD, vía trends24.in (scraping público,
// sin API key). El primer bloque de la línea de tiempo es el más reciente.
async function fetchTwitterTrends() {
  const html = await fetchText('https://trends24.in/dominican-republic/');
  const $ = cheerio.load(html);
  const items = [];
  $('.list-container').first().find('a.trend-link').each((_, el) => {
    const text = $(el).text().trim();
    if (text) items.push(text);
  });
  return items;
}

// "Jueves 2", "Miércoles 1" — ruido recurrente de trends24 sin valor editorial.
function isNoise(text) {
  return /^(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s*\d*$/i.test(text);
}

// Búsquedas en tendencia de Google para RD, vía su feed RSS oficial (sin API key).
async function fetchGoogleTrends() {
  const xml = await fetchText('https://trends.google.com/trending/rss?geo=DO');
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  return blocks
    .map(block => ({
      title: (block.match(/<title>([^<]+)<\/title>/)?.[1] ?? '').trim(),
      traffic: (block.match(/<ht:approx_traffic>([^<]+)<\/ht:approx_traffic>/)?.[1] ?? '').trim(),
    }))
    .filter(t => t.title);
}

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function trafficNumber(traffic) {
  return parseInt((traffic || '0').replace(/[^\d]/g, ''), 10) || 0;
}

// Cruza ambas fuentes: si un tema de Google Trends también aparece en el
// trending de Twitter/X, es señal doble — el dominicano lo busca y lo
// comenta al mismo tiempo, así que sube de prioridad.
export async function getTrendingBrief() {
  const [twitterRes, googleRes] = await Promise.allSettled([fetchTwitterTrends(), fetchGoogleTrends()]);

  const twitter = twitterRes.status === 'fulfilled' ? twitterRes.value.filter(t => !isNoise(t)) : [];
  const google = googleRes.status === 'fulfilled' ? googleRes.value : [];
  const twitterNorm = twitter.map(normalize);

  const topics = google
    .map(g => {
      const words = normalize(g.title).split(' ').filter(w => w.length > 2);
      const crossed = twitterNorm.some(tw => words.some(w => tw.includes(w) || w.includes(tw)));
      return { ...g, crossed };
    })
    .sort((a, b) => (b.crossed - a.crossed) || (trafficNumber(b.traffic) - trafficNumber(a.traffic)))
    .slice(0, 8);

  return {
    topics,
    twitterOk: twitterRes.status === 'fulfilled',
    googleOk: googleRes.status === 'fulfilled',
  };
}
