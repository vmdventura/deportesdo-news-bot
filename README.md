# DeportesDO News Bot

Bot de Telegram (**@deportesdo_news_bot**) que publica noticias deportivas en [DeportesDo.com](https://deportesdo.com) con redacción por IA optimizada para SEO (Rank Math).

## Flujo

1. Envía la URL de un artículo al bot (o `/noticia [URL]`)
2. Envía la foto para la noticia (o la foto con la URL en el caption)
3. El bot: scrapea la fuente (con reintento anti-bloqueo tipo ESPN) → Claude reescribe en español dominicano con validación SEO (keyword exacta en título/slug/H2, 650-800 palabras, reintenta hasta 3 veces) → sube la foto con alt → crea/asigna etiquetas → asigna la taxonomía `deporte` (federación) y la categoría nativa correspondiente → publica con meta de Rank Math y enlace interno.

Comandos: `/noticia [URL]`, `/tendencias` (cruza Twitter/X y Google Trends en RD), `/cancelar`.

## Configuración

Secretos de GitHub Actions (ver `.env.example`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD`, `ANTHROPIC_API_KEY`.

Requisitos del WordPress:

- Usuario con rol **Editor** y Application Password.
- Plugin `deportesdo-core` con la taxonomía `deporte` (federaciones) y el endpoint público `deportesdo/v1/taxonomy-map`.
- Los campos meta de Rank Math (`rank_math_focus_keyword`, `rank_math_description`, `rank_math_title`) registrados en el REST API con `register_post_meta` (`show_in_rest`).

## Ejecución

Corre 24/7 en GitHub Actions (`.github/workflows/telegram-bot.yml`): se reinicia cada 5 horas y con cada push a `main`.

```bash
npm install
npm start   # local, requiere .env
```

Proyecto hermano: [rdparty-news-bot](https://github.com/vmdventura/rdparty-news-bot) (bot de RDparty, mismo diseño, SEO con Yoast).
