# Wayback Link Preserver

Micro.blog-plugin som hittar trasiga externa länkar och visar Wayback Machine-arkivlänkar.

## Arkitektur

Micro.blog-plugins är Hugo-teman — ren klient-sida, ingen server-side kod möjlig.

### Tvåfas-approach (klient-sida JS)
1. **Fas 1 — Liveness**: `fetch(url, {mode: "no-cors"})` parallellt (6 st). Fångar döda domäner, nere servrar, DNS-fel, timeout. Cachas 1 dag i localStorage.
2. **Fas 2 — Arkivkoll**: Bara trasiga länkar → JSONP till Wayback Machine Availability API (`archive.org/wayback/available`). Sekventiellt, 350ms delay. Cachas 7 dagar.

### CORS-begränsning
Wayback Machine API saknar CORS-headers → vanlig `fetch()` fungerar inte → JSONP via `?callback=` parameter.

### Begränsning
Kan INTE detektera HTTP 404 på fungerande servrar (no-cors ger opaque response). Bara server-level-fel (DNS, connection refused, timeout).

## Filstruktur

```
plugin.json                          # Micro.blog manifest (version, titel, fält)
config.json                          # Default-parametervärden
layouts/partials/
  wayback-link-preserver.html        # Injiceras i <head>, konfigurerar JS
static/js/
  wayback-link-preserver.js          # Huvudlogik (liveness + JSONP + DOM)
static/css/
  wayback-link-preserver.css         # Badge-stilar, dark mode, a11y, print
preview.html                         # Interaktiv demo av alla tre link-states
wayback-link-preserver_icon.png      # Plugin-ikon för Micro.blog-katalogen
```

## Lokala filer (ej i git)

- `_KONTEXT.md` — research och projektöversikt
- `blogpost.md` — engelskspråkigt blogginlägg om pluginet
- `icon.html` — HTML-källa för ikonen (renderad med Puppeteer)

## Wayback Machine API

- **Availability API**: `GET https://archive.org/wayback/available?url={url}&callback={cb}`
- **CDX API** (ej använd, men kraftfullare): `GET https://web.archive.org/cdx/search/cdx?url={url}`
- **Rate limits**: CDX ~60 req/min. Availability API har mjukare gränser men bör respekteras.
- Arkiverad URL-format: `https://web.archive.org/web/{timestamp}/{url}`

## Kommandon

```bash
# Testa lokalt — öppna preview
open preview.html

# Generera ny ikon
node -e "
const puppeteer = require('/Users/gunnar/Code/click/node_modules/puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 200, height: 200, deviceScaleFactor: 2 });
  await page.goto('file://$(pwd)/icon.html');
  await page.screenshot({ path: 'wayback-link-preserver_icon.png' });
  await browser.close();
})();
"
```

## Deploy

Pluginet distribueras via GitHub-repot. Micro.blog hämtar filer därifrån.
Registrering: https://micro.blog/account/plugins/register
