# Wayback Link Preserver

A [Micro.blog](https://micro.blog) plugin that protects your blog against [link rot](https://en.wikipedia.org/wiki/Link_rot). It automatically checks every external link on your pages against the [Internet Archive Wayback Machine](https://web.archive.org/) and adds a small, clickable archive indicator next to links that have been preserved. If a link you shared ever goes offline, your readers will have a one-click fallback to the archived version.

## How It Works

When a reader opens one of your blog posts, the plugin:

1. **Finds** all external links inside your post content.
2. **Checks** each unique URL against the Wayback Machine's public [Availability API](https://archive.org/help/wayback_api.php) to see if an archived snapshot exists.
3. **Adds a small archive icon** (🗃) next to links that have a snapshot. The icon links directly to the archived version on `web.archive.org`.
4. **Caches** the results in the reader's browser (via `localStorage`) so subsequent page loads are instant — no repeated API calls.

### What it looks like

After a link with an archived version:

> Check out [this great article](https://example.com/article) 🗃

The 🗃 icon is subtle and barely visible until hovered. Clicking it opens the Wayback Machine copy in a new tab. Links without archived versions are left completely unchanged.

## Installation

1. In your Micro.blog dashboard, go to **Plug-ins** → **Find Plug-ins**.
2. Search for **Wayback Link Preserver**.
3. Click **Install**.

That's it — the plugin works out of the box with sensible defaults.

### Manual installation (from GitHub)

1. Go to **Plug-ins** → **Find Plug-ins** → **Install from URL**.
2. Enter the GitHub repository URL for this plugin.

## Settings

After installing, go to **Plug-ins** → **Wayback Link Preserver** to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Indicator style** | `icon` | How the archive link is displayed. Options: `icon` (small archive icon), `text` (the word "archived"), `both` (icon + text). |
| **Cache duration (days)** | `7` | How many days lookup results are cached in the reader's browser. Lower values mean more frequent re-checks; higher values reduce API calls. |
| **Max links per page** | `30` | Maximum number of unique external URLs to check per page load. Keeps things fast on link-heavy pages. |
| **Disable plugin** | `false` | Toggle the plugin off without uninstalling it. |

## Architecture

### Pure client-side — no server required

Unlike the [WordPress Wayback Machine Link Fixer](https://wordpress.org/plugins/internet-archive-wayback-machine-link-fixer/) which uses PHP and background jobs, this plugin runs entirely in the browser. Micro.blog is built on [Hugo](https://gohugo.io/) (a static site generator), so plugins cannot run server-side code. The plugin works within these constraints by using:

- **JSONP** to query the Wayback Machine API directly from the browser (the API doesn't support CORS, so regular `fetch()` won't work).
- **localStorage** for caching, so the API is only queried once per URL per cache period.
- **Rate limiting** (one request every 350ms) to stay well under the Wayback Machine's rate limits.

### What this means in practice

- **No background scanning**: Links are checked when a reader visits the page, not ahead of time.
- **No broken-link detection**: The plugin doesn't check whether links are actually broken. It shows the archive indicator for any link that happens to have a Wayback Machine snapshot, giving readers a ready-made fallback.
- **No content modification**: Your posts are never modified. The archive indicators are added purely in the browser's DOM.

### File structure

```
wayback-link-preserver/
├── plugin.json                     # Plugin manifest for Micro.blog
├── config.json                     # Default parameter values
├── LICENSE                         # MIT License
├── README.md                       # This file
├── layouts/
│   └── partials/
│       └── wayback-link-preserver.html  # Injected into <head>
└── static/
    ├── css/
    │   └── wayback-link-preserver.css   # Indicator styles
    └── js/
        └── wayback-link-preserver.js    # Main logic
```

### Request flow

```
Page loads
    │
    ▼
Find external links in .post-content / .e-content
    │
    ▼
For each unique URL:
    │
    ├─ Cached in localStorage? ──yes──▶ Use cached result
    │
    └─ Not cached ──▶ Queue JSONP request to:
                       https://archive.org/wayback/available?url=...&callback=...
                           │
                           ▼
                     Parse response
                           │
                   ┌───────┴───────┐
                   │               │
              Has snapshot    No snapshot
                   │               │
                   ▼               ▼
            Add indicator     Do nothing
            Cache: true      Cache: false
```

## Privacy

The plugin sends external link URLs to [archive.org](https://archive.org)'s public Availability API. This is the same API used by the [Wayback Machine browser extension](https://web.archive.org/) and millions of other tools.

**What is sent:** Only the URL of the external link (e.g., `https://example.com/article`).

**What is NOT sent:** No cookies, no visitor information, no IP tracking, no analytics. The requests are made by the reader's browser directly to archive.org.

If you're concerned about sending link URLs to a third party, you can disable the plugin from its settings page.

## Accessibility

- Archive indicators have proper `aria-label` attributes describing what they do.
- Icons are marked `aria-hidden="true"` so screen readers skip the decorative SVG and read the label instead.
- Keyboard navigation works: indicators are focusable `<a>` elements with visible focus styles.
- Print styles hide indicators since they're not useful on paper.
- The `prefers-reduced-motion` media query disables animations for users who prefer it.

## Performance

- **Caching**: Results are stored in `localStorage` for 7 days (configurable). A returning reader triggers zero API calls.
- **Rate limiting**: API requests are spaced 350ms apart to avoid hitting the Wayback Machine's rate limits (60 requests/minute threshold).
- **Deduplication**: If the same URL appears in multiple links, it's only checked once.
- **Max cap**: Only the first 30 unique URLs per page are checked (configurable), preventing runaway behavior on archive/timeline pages with hundreds of posts.
- **Deferred loading**: The script is loaded with `defer`, so it never blocks page rendering.
- **Tiny footprint**: The JavaScript is ~5 KB unminified, the CSS ~1.5 KB.

## Limitations

- **No broken-link detection**: The plugin doesn't verify whether the original link is still alive. It shows the archive indicator as a precaution for any link that has a Wayback Machine snapshot, regardless of whether the link is currently working.
- **No proactive archiving**: The plugin doesn't request the Wayback Machine to archive links. If a link has never been crawled by the Internet Archive, no indicator is shown. (Tip: Use the [Wayback Machine browser extension](https://web.archive.org/) or the [Save Page Now](https://web.archive.org/save) service to proactively archive important links.)
- **Markdown links only (mostly)**: The plugin scans all `<a>` tags in your post content containers, so it works with both Markdown links and raw HTML links. However, it only looks inside elements matching the configured content selector.
- **JSONP dependency**: The Wayback Machine Availability API doesn't support CORS, so the plugin uses JSONP. If archive.org ever removes JSONP support, the plugin would need a proxy server or API change.
- **Client-side only**: Since Micro.blog plugins can't run server-side code, all processing happens in the reader's browser. Search engines and RSS readers see your original content without archive indicators.

## Comparison with the WordPress Plugin

| Feature | WP Wayback Link Fixer | This plugin |
|---------|----------------------|-------------|
| Platform | WordPress (PHP) | Micro.blog (Hugo/JS) |
| Link checking | Server-side, background jobs | Client-side, on page load |
| Broken-link detection | Yes (HTTP HEAD checks) | No |
| Proactive archiving | Yes (Save Page Now API) | No |
| Content modification | No (JS replacement at render) | No (JS indicators at load) |
| Rate limiting | Action Scheduler queues | Request queue with delay |
| Caching | Custom database table | Browser localStorage |
| Indicator style | Silent href swap | Visible archive icon |
| RSS/crawler visibility | Original links only | Original links only |

## Future ideas

- **Companion service**: A small server-side script that periodically checks your blog's links, proactively archives them via Save Page Now, and pre-populates a JSON file the plugin can read — eliminating runtime API calls entirely.
- **Build-time integration**: A Hugo data file with pre-checked archive URLs, populated by a CI/CD step, so the archive indicators are baked into the static HTML.
- **Broken-link highlighting**: Use the archive indicator to visually distinguish links that are likely broken (e.g., by attempting a `fetch` and detecting network errors).

## Contributing

Issues and pull requests are welcome! This plugin is open source under the MIT License.

## Credits

- Built for [Micro.blog](https://micro.blog) by the plugin system described in the [Micro.blog help docs](https://help.micro.blog/t/plug-ins/104).
- Uses the [Internet Archive Wayback Machine Availability API](https://archive.org/help/wayback_api.php).
- Inspired by the [Internet Archive Wayback Machine Link Fixer](https://wordpress.org/plugins/internet-archive-wayback-machine-link-fixer/) WordPress plugin by Automattic and the Internet Archive.
- Archive icon from the [Lucide](https://lucide.dev/) icon set (MIT License).

## License

MIT — see [LICENSE](LICENSE).
