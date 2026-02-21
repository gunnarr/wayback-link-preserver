/**
 * Wayback Link Preserver for Micro.blog
 *
 * Scans external links on the page, checks whether each link is still
 * reachable, and for broken links looks up an archived version on the
 * Internet Archive Wayback Machine. Broken links with a snapshot get a
 * clickable archive indicator so readers can still access the content.
 *
 * Two-phase approach:
 *   Phase 1 — Liveness: For every external link, a lightweight `fetch`
 *             (mode: "no-cors") determines if the server responds at all.
 *             These run in parallel with a concurrency cap.
 *   Phase 2 — Archive lookup: Only for links that failed the liveness
 *             check, a JSONP request to the Wayback Machine Availability
 *             API looks for an archived snapshot. These run sequentially
 *             to respect archive.org rate limits.
 *
 * Both phases cache their results in localStorage so repeat visits are
 * instant with zero network requests.
 *
 * Privacy: External link URLs are sent to their own servers (HEAD-like
 * fetch) and, for broken links only, to archive.org's public API. No
 * visitor data, cookies, or personal information is transmitted.
 *
 * @version 1.0.0
 * @license MIT
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  var userConfig = window.WaybackLinkPreserver || {};

  var config = {
    /** CSS selector for containers that hold post content. */
    contentSelector:
      userConfig.contentSelector ||
      ".post-content, .e-content, article .content, .h-entry .e-content",

    /** How many days to cache archive lookup results in localStorage. */
    cacheDays: userConfig.cacheDays || 7,

    /** How many days to cache liveness results (shorter — sites come back). */
    livenessCacheDays: userConfig.livenessCacheDays || 1,

    /** Delay in ms between consecutive Wayback API requests (rate limiting). */
    checkDelay: userConfig.checkDelay || 350,

    /** Maximum number of unique URLs to process per page load. */
    maxLinksPerPage: userConfig.maxLinksPerPage || 30,

    /** How many liveness checks to run in parallel. */
    concurrency: userConfig.concurrency || 6,

    /** Timeout in ms for each liveness fetch. */
    livenessTimeout: userConfig.livenessTimeout || 8000,

    /** JSONP request timeout in ms. */
    jsonpTimeout: userConfig.jsonpTimeout || 10000,
  };

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var CACHE_LIVE = "wlp-l:"; // liveness cache key prefix
  var CACHE_ARCH = "wlp-a:"; // archive cache key prefix
  var LIVE_TTL = config.livenessCacheDays * 86400000;
  var ARCH_TTL = config.cacheDays * 86400000;
  var API_BASE = "https://archive.org/wayback/available";

  // "Archive box" icon (Lucide, MIT license).
  var ICON_ARCHIVE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="3" width="20" height="5" rx="1"/>' +
    '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>' +
    '<path d="M10 12h4"/>' +
    "</svg>";

  // "Broken link" icon (Lucide, MIT license).
  var ICON_BROKEN =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/>' +
    '<path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/>' +
    '<line x1="8" y1="2" x2="8" y2="5"/>' +
    '<line x1="2" y1="8" x2="5" y2="8"/>' +
    '<line x1="16" y1="19" x2="16" y2="22"/>' +
    '<line x1="19" y1="16" x2="22" y2="16"/>' +
    "</svg>";

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /** Simple string hash → short base-36 key. */
  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36);
  }

  /** Format Wayback timestamp "YYYYMMDDhhmmss" → "YYYY-MM-DD". */
  function formatDate(ts) {
    if (!ts || ts.length < 8) return "unknown date";
    return ts.slice(0, 4) + "-" + ts.slice(4, 6) + "-" + ts.slice(6, 8);
  }

  // ---------------------------------------------------------------------------
  // localStorage cache (two separate namespaces)
  // ---------------------------------------------------------------------------

  function cacheGet(prefix, ttl, url) {
    try {
      var raw = localStorage.getItem(prefix + hash(url));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (Date.now() - entry.t > ttl) {
        localStorage.removeItem(prefix + hash(url));
        return null;
      }
      return entry;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(prefix, url, data) {
    try {
      data.t = Date.now();
      localStorage.setItem(prefix + hash(url), JSON.stringify(data));
    } catch (e) {
      // Full or unavailable — continue without caching.
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — Liveness checking
  // ---------------------------------------------------------------------------

  /**
   * Check if a server responds to a no-cors fetch.
   *
   * `fetch` with `mode: "no-cors"` sends a real request but returns an
   * opaque response (status 0, no body). We cannot read the HTTP status,
   * but we CAN distinguish between:
   *
   *   - Server responded (resolve)  → link is alive.
   *   - Network error (reject)      → DNS failure, connection refused,
   *                                    timeout, SSL error → likely dead.
   *
   * This catches the most common forms of link rot: expired domains,
   * servers that have been shut down, and DNS that no longer resolves.
   *
   * Limitation: A server returning HTTP 404 still "responds", so this
   * method cannot detect individual deleted pages on an otherwise healthy
   * server. That would require a server-side companion service.
   */
  function checkLiveness(url) {
    var cached = cacheGet(CACHE_LIVE, LIVE_TTL, url);
    if (cached) return Promise.resolve(cached.alive);

    var controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, config.livenessTimeout);

    var opts = { mode: "no-cors", cache: "no-store", redirect: "follow" };
    if (controller) opts.signal = controller.signal;

    return fetch(url, opts)
      .then(function () {
        clearTimeout(timer);
        cacheSet(CACHE_LIVE, url, { alive: true });
        return true;
      })
      .catch(function () {
        clearTimeout(timer);
        cacheSet(CACHE_LIVE, url, { alive: false });
        return false;
      });
  }

  /**
   * Check liveness of multiple URLs with bounded concurrency.
   * Returns a plain object: { url: boolean, ... }
   */
  function checkAllLiveness(urls) {
    var results = {};
    var queue = urls.slice(); // shallow copy

    function worker() {
      if (queue.length === 0) return Promise.resolve();
      var url = queue.shift();
      return checkLiveness(url).then(function (alive) {
        results[url] = alive;
        return worker(); // process next
      });
    }

    // Start `concurrency` workers in parallel.
    var workers = [];
    for (var i = 0; i < Math.min(config.concurrency, urls.length); i++) {
      workers.push(worker());
    }

    return Promise.all(workers).then(function () {
      return results;
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Wayback Machine archive lookup (JSONP)
  // ---------------------------------------------------------------------------

  /** JSONP request with timeout. */
  function jsonp(url) {
    return new Promise(function (resolve) {
      var cbName = "_wlp_" + Math.random().toString(36).slice(2, 11);
      var script = document.createElement("script");
      var done = false;

      function cleanup() {
        if (done) return;
        done = true;
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      var timer = setTimeout(function () {
        cleanup();
        resolve(null);
      }, config.jsonpTimeout);

      window[cbName] = function (data) {
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      script.onerror = function () {
        clearTimeout(timer);
        cleanup();
        resolve(null);
      };

      script.src = url + "&callback=" + cbName;
      document.head.appendChild(script);
    });
  }

  /** Sequential queue with delay between items. */
  function createQueue(delay) {
    var items = [];
    var running = false;

    function next() {
      if (items.length === 0) {
        running = false;
        return;
      }
      running = true;
      var item = items.shift();
      item
        .fn()
        .then(item.resolve)
        .catch(function () {
          item.resolve(null);
        })
        .then(function () {
          if (items.length > 0) setTimeout(next, delay);
          else running = false;
        });
    }

    return {
      add: function (fn) {
        return new Promise(function (resolve) {
          items.push({ fn: fn, resolve: resolve });
          if (!running) next();
        });
      },
    };
  }

  /**
   * Look up a single URL in the Wayback Machine.
   * Returns: { archived: true, archiveUrl, timestamp } or { archived: false }
   */
  function checkArchive(url, queue) {
    var cached = cacheGet(CACHE_ARCH, ARCH_TTL, url);
    if (cached) {
      return Promise.resolve({
        archived: !!cached.u,
        archiveUrl: cached.u || undefined,
        timestamp: cached.ts || undefined,
      });
    }

    return queue
      .add(function () {
        return jsonp(API_BASE + "?url=" + encodeURIComponent(url));
      })
      .then(function (data) {
        var result;
        if (
          data &&
          data.archived_snapshots &&
          data.archived_snapshots.closest &&
          data.archived_snapshots.closest.available
        ) {
          var snap = data.archived_snapshots.closest;
          result = {
            archived: true,
            archiveUrl: snap.url.replace(/^http:\/\//, "https://"),
            timestamp: snap.timestamp,
          };
          cacheSet(CACHE_ARCH, url, { u: result.archiveUrl, ts: snap.timestamp });
        } else {
          result = { archived: false };
          cacheSet(CACHE_ARCH, url, {});
        }
        return result;
      });
  }

  // ---------------------------------------------------------------------------
  // DOM — collecting links
  // ---------------------------------------------------------------------------

  /**
   * Find all external links in content containers.
   * Returns { byUrl: { href: [elements] }, order: [hrefs] }
   */
  function collectLinks() {
    var containers = document.querySelectorAll(config.contentSelector);
    var byUrl = {};
    var order = [];
    var hostname = window.location.hostname;

    for (var c = 0; c < containers.length; c++) {
      var anchors = containers[c].querySelectorAll("a[href]");
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        if (a.classList.contains("wlp-indicator")) continue;
        if (a.classList.contains("wlp-broken-badge")) continue;

        try {
          var parsed = new URL(a.href);
        } catch (e) {
          continue;
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          continue;
        if (parsed.hostname === hostname) continue;
        if (
          parsed.hostname === "archive.org" ||
          parsed.hostname.endsWith(".archive.org")
        )
          continue;
        if (a.getAttribute("href").indexOf("mailto:") === 0) continue;

        var href = parsed.href;
        if (!byUrl[href]) {
          byUrl[href] = [];
          order.push(href);
        }
        byUrl[href].push(a);
      }
    }

    return { byUrl: byUrl, order: order };
  }

  // ---------------------------------------------------------------------------
  // DOM — rendering indicators
  // ---------------------------------------------------------------------------

  /** Create a clickable archive indicator. */
  function createArchiveIndicator(result) {
    var el = document.createElement("a");
    el.href = result.archiveUrl;
    el.className = "wlp-indicator";
    el.target = "_blank";
    el.rel = "noopener noreferrer";

    var date = formatDate(result.timestamp);
    el.title = "This link appears broken — click to view an archived copy from " + date;
    el.setAttribute("aria-label", "Link is broken. View archived copy from " + date);

    el.innerHTML = ICON_ARCHIVE + '<span class="wlp-indicator-text">View archived copy</span>';
    return el;
  }

  /** Create a non-clickable "broken link" badge (no archive available). */
  function createBrokenBadge() {
    var el = document.createElement("span");
    el.className = "wlp-broken-badge";
    el.title = "This link appears to be broken — no archived version available";
    el.setAttribute("aria-label", "Link is broken, no archived version available");
    el.innerHTML = ICON_BROKEN;
    return el;
  }

  /** Mark a link as broken and optionally attach an archive indicator. */
  function markBroken(link, archiveResult) {
    // Don't double-process.
    if (link.classList.contains("wlp-broken")) return;
    link.classList.add("wlp-broken");

    if (archiveResult && archiveResult.archived) {
      // Broken + archive exists → show archive indicator.
      link.classList.add("wlp-has-archive");
      var indicator = createArchiveIndicator(archiveResult);
      link.parentNode.insertBefore(indicator, link.nextSibling);
    } else {
      // Broken + no archive → show broken badge.
      var badge = createBrokenBadge();
      link.parentNode.insertBefore(badge, link.nextSibling);
    }
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  function init() {
    // Bail out if fetch is not available (very old browsers).
    if (typeof fetch === "undefined") return;

    var data = collectLinks();
    if (data.order.length === 0) return;

    var urls = data.order.slice(0, config.maxLinksPerPage);

    // --- Phase 1: Liveness ---
    checkAllLiveness(urls).then(function (livenessResults) {
      // Collect broken URLs.
      var brokenUrls = [];
      for (var i = 0; i < urls.length; i++) {
        if (!livenessResults[urls[i]]) {
          brokenUrls.push(urls[i]);
        }
      }

      if (brokenUrls.length === 0) return; // All links are alive!

      // --- Phase 2: Archive lookup (only for broken links) ---
      var archiveQueue = createQueue(config.checkDelay);

      var archiveChecks = brokenUrls.map(function (url) {
        return checkArchive(url, archiveQueue).then(function (archiveResult) {
          var links = data.byUrl[url];
          if (!links) return;
          for (var j = 0; j < links.length; j++) {
            markBroken(links[j], archiveResult);
          }
        });
      });

      // All done when every archive check resolves.
      Promise.all(archiveChecks);
    });
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
