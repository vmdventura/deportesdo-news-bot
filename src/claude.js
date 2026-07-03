import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres un redactor deportivo senior de DeportesDo.com, el portal de noticias deportivas de República Dominicana. Reescribe artículos deportivos en español dominicano con estilo periodístico profesional, optimizados para SEO con Rank Math. El objetivo es que cada artículo puntúe 80+ en Rank Math.

Regla de oro (la más importante): elige PRIMERO la keyword y construye el título alrededor de ella. Rank Math busca la frase EXACTA — "España choca ante Austria" NO contiene la keyword "España vs Austria". La keyword debe ser de 2 a 4 palabras para que quepa literal en el título.

Reglas del título:
- Máximo 60 caracteres, DEBE contener la keyword principal EXACTA (la misma secuencia de palabras, idealmente al inicio del título)
- Incluye un número cuando sea natural (años, cifras, cantidad de jugadores)
- Incluye una palabra de impacto cuando sea natural (histórico, clave, brilla, sorprende, imperdible, confirmado)

Reglas del contenido (HTML con <p> y <h2>):
- Entre 650 y 800 palabras. NUNCA menos de 650. Expande con contexto: historial del atleta/equipo, cifras, qué significa para el deporte dominicano, próximos pasos.
- Estructura: 2 párrafos intro → <h2> → 2-3 párrafos → <h2> → 2-3 párrafos → <h2>Conclusión</h2> → cierre
- La keyword EXACTA debe aparecer: en el primer párrafo, en al menos un <h2>, y 4-6 veces en total en el contenido (siempre la misma secuencia de palabras). No la fuerces hasta sonar robótico.
- Párrafos cortos (2-4 oraciones)

Reglas de metadatos:
- Keyword principal: 2 a 4 palabras, específica de la noticia (no genérica como "béisbol"). Ejemplos buenos: "Futures Game 2026", "España vs Austria", "Juan Soto Mets"
- Meta descripción: entre 150 y 158 caracteres, incluye la keyword
- Excerpt: una oración de 20-25 palabras
- Slug: minúsculas, sin acentos, con guiones, y DEBE contener la keyword normalizada (ej: keyword "Futures Game 2026" → slug que incluya "futures-game-2026")
- image_alt: describe la foto en una frase corta que incluya la keyword
- Etiquetas: 3 a 6, específicas (nombres de atletas, equipos, torneos, la liga). Capitalización natural.`;

// deporteSlugs: slugs válidos de la taxonomía 'deporte' del sitio (taxonomy-map).
// Se pasa como enum para que Claude solo pueda elegir un deporte que existe.
function buildArticleTool(deporteSlugs) {
  return {
    name: 'publicar_noticia',
    description: 'Publica la noticia reescrita con SEO en WordPress',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título SEO, máximo 60 caracteres; DEBE contener la keyword EXACTA (misma secuencia de palabras), idealmente al inicio' },
        html: { type: 'string', description: 'Contenido HTML de 650-800 palabras con etiquetas p y h2; keyword exacta en el primer párrafo, en un h2 y 4-6 veces en total' },
        focus_keyword: { type: 'string', description: 'Keyword principal para Rank Math, 2-4 palabras específicas de la noticia' },
        meta_description: { type: 'string', description: 'Meta descripción de 150-158 caracteres con la keyword' },
        excerpt: { type: 'string', description: 'Resumen en una oración de 20-25 palabras' },
        slug: { type: 'string', description: 'URL amigable en minúsculas sin acentos; DEBE contener la keyword normalizada' },
        image_alt: { type: 'string', description: 'Texto alternativo de la foto: frase corta que incluye la keyword' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '3 a 6 etiquetas específicas: atletas, equipos, torneos, liga',
        },
        deporte_slug: {
          type: 'string',
          description: 'Deporte/federación del artículo. Elige el slug que mejor corresponda.',
          ...(deporteSlugs?.length ? { enum: deporteSlugs } : {}),
        },
      },
      required: ['title', 'html', 'focus_keyword', 'meta_description', 'excerpt', 'slug', 'image_alt', 'tags', 'deporte_slug'],
    },
  };
}

// Comparación al estilo Rank Math: minúsculas y sin acentos
function normalize(s = '') {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return normalize(haystack).split(normalize(needle)).length - 1;
}

// Replica los checks de Rank Math que más pesan. Si algo falla, se le
// devuelve a Claude como tool_result para que corrija y regenere.
export function validateArticle(a) {
  const issues = [];
  const kw = a.focus_keyword || '';
  const plain = String(a.html || '').replace(/<[^>]+>/g, ' ');
  const words = plain.split(/\s+/).filter(Boolean).length;

  if (kw.split(/\s+/).length > 4) {
    issues.push('La keyword tiene más de 4 palabras. Elige una de 2 a 4 palabras y reescribe todo alrededor de ella.');
  }
  if (!normalize(a.title).includes(normalize(kw))) {
    issues.push(`El título NO contiene la keyword exacta "${kw}". Reescribe el título incluyéndola tal cual, idealmente al inicio.`);
  }
  const kwSlug = normalize(kw).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (kwSlug && !normalize(a.slug).includes(kwSlug)) {
    issues.push(`El slug NO contiene la keyword normalizada ("${kwSlug}").`);
  }
  if (words < 620) {
    issues.push(`El contenido tiene ${words} palabras; escribe entre 650 y 800.`);
  }
  if (countOccurrences(plain, kw) < 4) {
    issues.push(`La keyword exacta "${kw}" aparece menos de 4 veces en el contenido. Úsala 4-6 veces de forma natural.`);
  }
  if (!normalize(a.meta_description).includes(normalize(kw))) {
    issues.push('La meta descripción no contiene la keyword exacta.');
  }
  const h2s = String(a.html || '').match(/<h2[^>]*>.*?<\/h2>/gs) || [];
  if (!h2s.some(h => normalize(h).includes(normalize(kw)))) {
    issues.push('Ningún subtítulo <h2> contiene la keyword exacta.');
  }
  return issues;
}

const MAX_ATTEMPTS = 3;

export async function rewriteArticle({ title, text, sourceUrl, deporteSlugs }) {
  const userMessage = `Reescribe esta noticia deportiva para DeportesDo.com:

TÍTULO ORIGINAL: ${title}
URL FUENTE: ${sourceUrl}

CONTENIDO:
${text}`;

  const messages = [{ role: 'user', content: userMessage }];
  let article = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [buildArticleTool(deporteSlugs)],
      tool_choice: { type: 'tool', name: 'publicar_noticia' },
      messages,
    });

    const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'publicar_noticia');
    if (!toolBlock?.input) throw new Error('Claude no generó la noticia. Intenta de nuevo.');

    article = toolBlock.input;
    const issues = validateArticle(article);
    if (!issues.length || attempt === MAX_ATTEMPTS) {
      if (issues.length) console.warn(`Artículo publicado con avisos SEO tras ${attempt} intentos:`, issues);
      return article;
    }

    console.log(`Intento ${attempt}: corrigiendo SEO —`, issues);
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: `El artículo NO cumple estos requisitos SEO. Corrígelos TODOS y vuelve a generar la noticia completa:\n- ${issues.join('\n- ')}`,
        is_error: true,
      }],
    });
  }

  return article;
}
