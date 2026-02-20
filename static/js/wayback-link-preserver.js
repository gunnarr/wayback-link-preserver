/**
 * Wayback Link Preserver for Micro.blog
 *
 * Scans external links on the page, checks each against the Internet Archive's
 * Wayback Machine, and adds a small archive indicator next to links that have
 * an archived snapshot. This gives readers a one-click fallback whenever a
 * linked page goes offline.
 *
 * How it works:
 *   1. On page load, all external links inside post content are collected.
 *   2. Each unique URL is checked against the Wayback Machine Availability API
 *      using JSONP (to avoid CORS restrictions).
 *   3. Results are cached in localStorage so repeat visits are instant.
 *   4. Links with archived snapshots get a small clickable icon that opens the
 *      archived version on web.archive.org.
 *
 * Privacy: The URLs of external links on the page are sent to archive.org's
 * public API. No visitor data, cookies, or personal information is transmitted.
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

    /** How many days to cache Wayback lookup results in localStorage. */
    cacheDays: userConfig.cacheDays || 7,

    /** Delay in ms between consecutive API requests (rate limiting). */
    checkDelay: userConfig.checkDelay || 350,

    /** Maximum number of unique URLs to check per page load. */
    maxLinksPerPage: userConfig.maxLinksPerPage || 30,

    /** Visual style of the archive indicator: "icon", "text", or "both". */
    indicatorStyle: userConfig.indicatorStyle || "icon",

    /** JSONP request timeout in ms. */
    timeout: userConfig.timeout || 8000,
  };

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var CACHE_PREFIX = "wlp:";
  var CACHE_TTL = config.cacheDays * 86400000; // days → ms
  var API_BASE = "https://archive.org/wayback/available";

  // A small "archive box" SVG icon (Lucide icon set, MIT license).
  var ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="3" width="20" height="5" rx="1"/>' +
    '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>' +
    '<path d="M10 12h4"/>' +
    "</svg>";

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Simple string hash for localStorage keys.
   * Returns a short base-36 string.
   */
  function hashUrl(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Format a Wayback timestamp (YYYYMMDDhhmmss) into a readable date.
   * Example: "20231015134522" → "2023-10-15"
   */
  function formatDate(ts) {
    if (!ts || ts.length < 8) return "unknown date";
    return ts.slice(0, 4) + "-" + ts.slice(4, 6) + "-" + ts.slice(6, 8);
  }

  // ---------------------------------------------------------------------------
  // localStorage cache
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a cached lookup result for a URL.
   * Returns the cached object, or null if missing/expired.
   */
  function getCache(url) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + hashUrl(url));
      if (!raw) return null;

      var entry = JSON.parse(raw);
      if (Date.now() - entry.t > CACHE_TTL) {
        localStorage.removeItem(CACHE_PREFIX + hashUrl(url));
        return null;
      }
      return entry;
    } catch (e) {
      return null;
    }
  }

  /**
   * Store a lookup result in cache.
   * Silently fails if localStorage is full or unavailable.
   */
  function setCache(url, data) {
    try {
      var entry = { t: Date.now(), a: data.archived };
      if (data.archived) {
        entry.u = data.archiveUrl;
        entry.ts = data.timestamp;
      }
      localStorage.setItem(CACHE_PREFIX + hashUrl(url), JSON.stringify(entry));
    } catch (e) {
      // localStorage unavailable or full — continue without caching.
    }
  }

  /**
   * Convert a cache entry back to the standard result format.
   */
  function fromCache(entry) {
    if (!entry) return null;
    var result = { archived: entry.a };
    if (entry.a) {
      result.archiveUrl = entry.u;
      result.timestamp = entry.ts;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // JSONP — cross-origin requests to the Wayback Availability API
  // ---------------------------------------------------------------------------

  /**
   * Make a JSONP request.
   *
   * The Wayback Machine Availability API supports JSONP via the `callback`
   * parameter, which lets us query it directly from the browser without a
   * proxy server.
   *
   * @param {string} url - Full API URL (without callback parameter).
   * @returns {Promise<Object|null>} Parsed JSON response, or null on error.
   */
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

      // Timeout: resolve with null if the API doesn't respond in time.
      var timer = setTimeout(function () {
        cleanup();
        resolve(null);
      }, config.timeout);

      // Success callback — called by the injected <script>.
      window[cbName] = function (data) {
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      // Network error.
      script.onerror = function () {
        clearTimeout(timer);
        cleanup();
        resolve(null);
      };

      script.src = url + "&callback=" + cbName;
      document.head.appendChild(script);
    });
  }

  // ---------------------------------------------------------------------------
  // Rate-limited request queue
  // ---------------------------------------------------------------------------

  /**
   * A simple sequential queue with a configurable delay between items.
   * Ensures we don't flood the Wayback Machine API.
   */
  function createQueue(delay) {
    var items = [];
    var running = false;

    function processNext() {
      if (items.length === 0) {
        running = false;
        return;
      }
      running = true;

      var item = items.shift();
      item
        .fn()
        .then(function (result) {
          item.resolve(result);
        })
        .catch(function () {
          item.resolve(null);
        })
        .then(function () {
          // Wait before processing the next item.
          if (items.length > 0) {
            setTimeout(processNext, delay);
          } else {
            running = false;
          }
        });
    }

    return {
      add: function (fn) {
        return new Promise(function (resolve) {
          items.push({ fn: fn, resolve: resolve });
          if (!running) processNext();
        });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Wayback Machine API
  // ---------------------------------------------------------------------------

  /**
   * Check a single URL against the Wayback Machine Availability API.
   * Returns a result object: { archived: bool, archiveUrl?: string, timestamp?: string }
   *
   * Uses the cache first; queues an API call if the URL isn't cached.
   */
  function checkUrl(url, queue) {
    // 1. Try cache first.
    var cached = fromCache(getCache(url));
    if (cached) {
      return Promise.resolve(cached);
    }

    // 2. Queue an API request.
    return queue.add(function () {
      var apiUrl = API_BASE + "?url=" + encodeURIComponent(url);
      return jsonp(apiUrl);
    }).then(function (data) {
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
          // Upgrade to HTTPS.
          archiveUrl: snap.url.replace(/^http:\/\//, "https://"),
          timestamp: snap.timestamp,
        };
      } else {
        result = { archived: false };
      }

      setCache(url, result);
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // DOM — finding external links
  // ---------------------------------------------------------------------------

  /**
   * Collect all external links inside content containers.
   *
   * Returns a Map: URL string → Array of <a> elements.
   * Duplicate URLs are grouped so we only check each URL once.
   */
  function collectLinks() {
    var containers = document.querySelectorAll(config.contentSelector);
    var byUrl = {};
    var order = []; // maintain discovery order
    var hostname = window.location.hostname;

    for (var c = 0; c < containers.length; c++) {
      var anchors = containers[c].querySelectorAll("a[href]");

      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];

        // Skip links that already have an indicator (e.g. from a cached render).
        if (a.querySelector(".wlp-indicator")) continue;
        if (a.classList.contains("wlp-indicator")) continue;

        try {
          var parsed = new URL(a.href);
        } catch (e) {
          continue; // Malformed URL.
        }

        // Only process http/https links.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          continue;

        // Skip same-domain links.
        if (parsed.hostname === hostname) continue;

        // Skip links already pointing to the Wayback Machine.
        if (
          parsed.hostname === "archive.org" ||
          parsed.hostname.endsWith(".archive.org")
        )
          continue;

        // Skip mailto-style links that browsers may have resolved oddly.
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
  // DOM — rendering the archive indicator
  // ---------------------------------------------------------------------------

  /**
   * Create an archive indicator element for a link.
   *
   * @param {Object} result - The Wayback lookup result.
   * @returns {HTMLElement} A clickable <a> element pointing to the archive.
   */
  function createIndicator(result) {
    var el = document.createElement("a");
    el.href = result.archiveUrl;
    el.className = "wlp-indicator";
    el.target = "_blank";
    el.rel = "noopener noreferrer";

    var date = formatDate(result.timestamp);
    el.title = "Archived version from " + date;
    el.setAttribute(
      "aria-label",
      "View archived version of this link from " + date
    );

    // Build the inner content based on the configured style.
    var html = "";
    if (config.indicatorStyle === "icon" || config.indicatorStyle === "both") {
      html += ICON_SVG;
    }
    if (config.indicatorStyle === "text" || config.indicatorStyle === "both") {
      html += '<span class="wlp-indicator-text">archived</span>';
    }
    el.innerHTML = html;

    return el;
  }

  /**
   * Attach an archive indicator after a link element.
   */
  function attachIndicator(link, result) {
    if (!result || !result.archived) return;

    // Don't double-attach.
    if (
      link.nextElementSibling &&
      link.nextElementSibling.classList.contains("wlp-indicator")
    )
      return;

    var indicator = createIndicator(result);
    link.classList.add("wlp-has-archive");
    link.parentNode.insertBefore(indicator, link.nextSibling);
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  function init() {
    var data = collectLinks();

    if (data.order.length === 0) return;

    var queue = createQueue(config.checkDelay);
    var urlsToCheck = data.order.slice(0, config.maxLinksPerPage);

    // Process each unique URL. Results are applied to all <a> elements
    // that share the same href.
    urlsToCheck.forEach(function (url) {
      checkUrl(url, queue).then(function (result) {
        var links = data.byUrl[url];
        if (!links) return;
        for (var i = 0; i < links.length; i++) {
          attachIndicator(links[i], result);
        }
      });
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
