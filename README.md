# Wayback Link Preserver

A [Micro.blog](https://micro.blog) plugin that detects broken external links on your blog and shows clickable [Wayback Machine](https://web.archive.org/) fallbacks so your readers can still access the content.

## How It Works

When a reader opens one of your blog posts, the plugin runs two phases:

### Phase 1 — Liveness check

Every external link on the page gets a lightweight network request (`fetch` with `mode: "no-cors"`) to see if the server behind it still responds. These checks run in parallel (6 at a time by default) and are fast — usually under a second for most pages.

If a server responds at all, the link is considered alive and left untouched.

### Phase 2 — Archive lookup (broken links only)

For links where the server did *not* respond (DNS failure, connection refused, timeout, SSL error), the plugin queries the Wayback Machine's [Availability API](https://archive.org/help/wayback_api.php) to find an archived snapshot.

- **Broken + archived** → A small clickable archive icon appears after the link. Clicking it opens the Wayback Machine copy in a new tab. The link text also gets a subtle strikethrough.
- **Broken + not archived** → A small broken-link icon appears as a visual hint. No clickable fallback is possible.
- **Working links** → Nothing changes. No icons, no styling.

### Caching

Both liveness results and archive lookups are cached in the reader's browser (`localStorage`):
- **Liveness**: cached for 1 day (sites come back online).
- **Archive data**: cached for 7 days (snapshots don't change often).

Returning visitors trigger zero network requests until caches expire.

### What it looks like

A broken link with an archived version:

> Check out ~~[this great article](https://example.com/article)~~ 🗃

The 🗃 icon links to the archived copy. Working links look completely normal.

## Installation

1. In your Micro.blog dashboard, go to **Plug-ins** → **Find Plug-ins**.
2. Search for **Wayback Link Preserver**.
3. Click **Install**.

That's it — the plugin works out of the box with sensible defaults.

### Manual installation (from GitHub)

1. Go to **Plug-ins** → **Find Plug-ins** → **Install from URL**.
2. Enter: `https://github.com/gunnarr/wayback-link-preserver`

## Settings

After installing, go to **Plug-ins** → **Wayback Link Preserver** to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Indicator style** | `icon` | How the archive link looks. Options: `icon` (small archive icon), `text` (the word "archived"), `both`. |
| **Archive cache (days)** | `7` | How long Wayback lookup results are cached per reader. |
| **Liveness cache (days)** | `1` | How long liveness results are cached. Lower = more responsive to sites coming back. |
| **Max links per page** | `30` | Cap on unique URLs to check per page load. |
| **Liveness timeout (ms)** | `8000` | How long to wait for a server to respond before declaring it broken. |
| **Disable plugin** | `false` | Toggle the plugin off without uninstalling it. |

## Architecture

### Two-phase, pure client-side — no server required

Micro.blog is built on [Hugo](https://gohugo.io/) (a static site generator), so plugins cannot run server-side code. This plugin works entirely in the reader's browser:

```
Page loads
    │
    ▼
Collect external links from post content
    │
    ▼
╔══════════════════════════════════════════╗
║  PHASE 1 — Liveness (parallel, fast)    ║
╠══════════════════════════════════════════╣
║                                          ║
║  For each URL (6 concurrent):            ║
║    ├─ Cached? → use cached result        ║
║    └─ fetch(url, {mode: "no-cors"})      ║
║        ├─ Responds → alive (skip)        ║
║        └─ Error/timeout → broken         ║
║                                          ║
╚══════════════════════════════════════════╝
    │
    │  Only broken URLs continue ↓
    ▼
╔══════════════════════════════════════════╗
║  PHASE 2 — Archive lookup (sequential)  ║
╠══════════════════════════════════════════╣
║                                          ║
║  For each broken URL (350ms between):    ║
║    ├─ Cached? → use cached result        ║
║    └─ JSONP → archive.org/wayback/...    ║
║        ├─ Snapshot found → add icon 🗃   ║
║        └─ Not found → add broken badge   ║
║                                          ║
╚══════════════════════════════════════════╝
```

**Why JSONP?** The Wayback Machine Availability API doesn't return CORS headers, so regular `fetch()` from browsers is blocked. JSONP (supported via the API's `callback` parameter) is the only way to query it directly without a proxy server.

### File structure

```
wayback-link-preserver/
├── plugin.json                          # Micro.blog manifest
├── config.json                          # Default parameter values
├── LICENSE                              # MIT License
├── README.md                            # This file
├── layouts/
│   └── partials/
│       └── wayback-link-preserver.html  # Injected into <head>
└── static/
    ├── css/
    │   └── wayback-link-preserver.css   # Indicator & broken link styles
    └── js/
        └── wayback-link-preserver.js    # Main logic (two-phase checker)
```

## Privacy

**Phase 1** (liveness) sends a no-cors fetch to each external link's own server. This is the same thing a browser does when a reader clicks the link — no extra data is exposed.

**Phase 2** (archive lookup) sends broken link URLs to [archive.org](https://archive.org)'s public API. Only the URL is sent. No cookies, visitor info, or tracking data.

## Accessibility

- Archive indicators have `aria-label` attributes ("Link is broken. View archived version from 2023-10-15").
- Decorative SVG icons are `aria-hidden="true"`.
- Keyboard-navigable: indicators are focusable `<a>` elements with focus-visible styles.
- `prefers-reduced-motion` disables transitions.
- Print styles hide indicators and remove strikethrough.

## Performance

On a typical blog post with 15 external links where 2 are broken:

| Phase | Requests | Duration |
|-------|----------|----------|
| Liveness (parallel) | 15 fetches, 6 concurrent | ~1–2 seconds |
| Archive lookup (sequential) | 2 JSONP calls | ~1 second |
| **Total** | **17 requests** | **~2–3 seconds** |
| **Repeat visit** | **0 requests** | **instant** |

- **Deduplication**: Same URL in multiple links is only checked once.
- **Max cap**: 30 URLs per page (configurable) prevents runaway behavior on archive pages.
- **Deferred loading**: Script loads with `defer` — never blocks rendering.
- **Tiny footprint**: ~7 KB JS + ~2 KB CSS (unminified).

## What it can and cannot detect

### Detects (server-level failures)
- Expired/parked domains (DNS failure)
- Servers that have been shut down (connection refused)
- Servers that are unreachable (timeout)
- SSL certificate errors

### Cannot detect (page-level issues)
- Individual pages deleted on an otherwise healthy server (HTTP 404)
- Soft 404s (server returns 200 but shows an error page)
- Paywalled or geo-blocked content
- Content that has changed significantly from what was linked

The limitation exists because `fetch` with `mode: "no-cors"` returns an opaque response — we can tell the server responded, but not *what* it responded with. Detecting page-level 404s would require a server-side companion service.

## Comparison with the WordPress Plugin

| Feature | WP Wayback Link Fixer | This plugin |
|---------|----------------------|-------------|
| Platform | WordPress (PHP) | Micro.blog (Hugo/JS) |
| Broken-link detection | Server-side HEAD requests | Client-side no-cors fetch |
| Detects 404s | Yes | No (server-level only) |
| Proactive archiving | Yes (Save Page Now API) | No |
| Background scanning | Yes (Action Scheduler) | No (on page load) |
| Content modification | No (JS at render time) | No (JS at load time) |
| Indicator style | Silent href swap | Visible icon + strikethrough |
| Caching | Server database | Browser localStorage |
| RSS/crawler visibility | Original links | Original links |

## Future ideas

- **Companion service**: A server-side script that periodically fetches your blog's links with full HTTP status checking (catching 404s too), archives them via Save Page Now, and outputs a JSON manifest the plugin reads — eliminating all runtime API calls.
- **Build-time integration**: Pre-checked archive data baked into the Hugo build, so archive indicators appear in the static HTML without any client-side API calls.

## Contributing

Issues and pull requests are welcome! This plugin is open source under the MIT License.

## Credits

- Built for [Micro.blog](https://micro.blog) using the [plugin system](https://help.micro.blog/t/plug-ins/104).
- Uses the [Internet Archive Wayback Machine Availability API](https://archive.org/help/wayback_api.php).
- Inspired by the [Internet Archive Wayback Machine Link Fixer](https://wordpress.org/plugins/internet-archive-wayback-machine-link-fixer/) WordPress plugin by Automattic and the Internet Archive.
- Icons from the [Lucide](https://lucide.dev/) icon set (MIT License).

## License

MIT — see [LICENSE](LICENSE).
