/* global WatchQueueStorage, WatchQueueManager, WATCHQUEUE_DEFAULT_SETTINGS */

(() => {
  const WQ = {
    widget: null,
    panel: null,
    observer: null,
    lastSavedAt: 0,
    videoListenerAttachedTo: null,
    lastKnownVideoId: null,
    resumeAppliedForVideoId: null,
    userOpenedPanel: false,
    isDraggingWidget: false,
    dragStart: null,
    suppressNextOrbClick: false,
    autoNextHandledForVideoId: null,
    autoNextTimer: null,
    activeTab: "queue",
    selectedPlaylistId: null,
    metadataRepairInFlight: false,
    queueSearch: "",
    settings: { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}) }
  };

  const PROGRESS_SAVE_INTERVAL_MS = 5000;
  const PANEL_WIDTH = 400;
  const PANEL_HEIGHT = 560;
  const PANEL_MARGIN = 12;

  const ACCENT_SWATCHES = ["#ff0033", "#3ea6ff", "#8b5cf6", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4"];

  // ---------- settings helpers ----------
  function settings() {
    return WQ.settings || {};
  }

  function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  async function loadSettings() {
    const state = await WatchQueueStorage.getState();
    WQ.settings = { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(state.settings || {}) };
    return WQ.settings;
  }

  // ---------- theme ----------
  function isYouTubeDark() {
    return Boolean(document.documentElement.hasAttribute("dark") || document.querySelector("html[dark]"));
  }

  function getThemeClass() {
    const theme = settings().theme || "auto";
    if (theme === "light") return "watchqueue-light";
    if (theme === "dark") return "watchqueue-dark";
    return isYouTubeDark() ? "watchqueue-dark" : "watchqueue-light";
  }

  function applyAccent(element) {
    if (!element) return;
    const accent = settings().accent || "#ff0033";
    element.style.setProperty("--wq-red", accent);
    const opacity = Math.min(100, Math.max(40, num(settings().panelOpacity, 100)));
    element.style.setProperty("--wq-panel-opacity", String(opacity));
  }

  function widgetStyleClass() {
    return settings().widgetStyle === "tab" ? "watchqueue-style-tab" : "watchqueue-style-pill";
  }

  function applyWidgetChrome() {
    if (!WQ.widget) return;
    const edge = WQ.widget.dataset.edge || WQ.widget.dataset.side || "right";
    WQ.widget.className = `watchqueue-widget ${getThemeClass()} ${widgetStyleClass()}`;
    WQ.widget.dataset.edge = edge;
    WQ.widget.dataset.side = edge;
    applyAccent(WQ.widget);
  }

  // ---------- text utils ----------
  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isBadVideoTitle(value) {
    const text = cleanText(value);
    return !text || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) || /^YouTube video\s+[a-zA-Z0-9_-]{6,}$/.test(text) || text.toLowerCase() === "youtube";
  }

  function cleanVideoTitle(value) {
    let text = cleanText(value);
    text = text.replace(/\s+-\s+Duration:\s*[^|]+$/i, "");
    text = text.replace(/\s+by\s+.+?\s+(?:\d[\d,.]*\s+views|No views).*/i, "");
    text = text.replace(/\s+\d[\d,.]*\s+views\s+.*$/i, "");
    return cleanText(text);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getVideoIdFromUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
      if (parsed.pathname.startsWith("/shorts/")) return parsed.pathname.split("/")[2];
      return null;
    } catch {
      return null;
    }
  }

  function getPlaylistIdFromUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.searchParams.get("list");
    } catch {
      return null;
    }
  }

  function getCurrentVideoId() {
    return getVideoIdFromUrl(window.location.href);
  }

  function isChannelPlaylistsPage() {
    try {
      const parsed = new URL(window.location.href);
      return parsed.hostname === "www.youtube.com" && parsed.pathname.includes("/playlists");
    } catch {
      return false;
    }
  }

  function isStandalonePlaylistPage(url = window.location.href) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.hostname === "www.youtube.com" && parsed.pathname === "/playlist" && parsed.searchParams.has("list");
    } catch {
      return false;
    }
  }

  function isShowPage(url = window.location.href) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.hostname === "www.youtube.com" && parsed.pathname.startsWith("/show/");
    } catch {
      return false;
    }
  }

  function canImportCurrentYouTubePage(url = window.location.href) {
    return isStandalonePlaylistPage(url) || isShowPage(url);
  }

  function getResumeSeconds(item) {
    if (!item || item.completed) return 0;
    const watched = Number(item.lastWatchedSeconds || 0);
    const minResume = num(settings().minResumeSeconds, 15);
    const rewind = num(settings().resumeRewindSeconds, 7);
    if (watched < minResume) return 0;
    return Math.max(0, Math.floor(watched - rewind));
  }

  function findCard(anchor) {
    return anchor.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, ytd-compact-radio-renderer, ytd-playlist-renderer, ytd-radio-renderer, ytd-rich-grid-media") || anchor.parentElement;
  }

  function getBestTitleFromCard(card, anchor, videoId) {
    const candidates = [
      card?.querySelector("a#video-title[title]"),
      card?.querySelector("#video-title-link[title]"),
      card?.querySelector("a.yt-lockup-metadata-view-model-wiz__title"),
      card?.querySelector("a[href*='/watch'][aria-label]"),
      card?.querySelector("yt-formatted-string#video-title"),
      card?.querySelector("h3 a[href*='/watch']"),
      card?.querySelector("h3"),
      anchor.closest("a#video-title"),
      anchor
    ].filter(Boolean);

    for (const node of candidates) {
      const possible = [
        node.getAttribute?.("title"),
        node.getAttribute?.("aria-label"),
        node.textContent
      ];
      for (const raw of possible) {
        const title = cleanVideoTitle(raw);
        if (!isBadVideoTitle(title) && title.length > 2) return title;
      }
    }

    const pageTitle = getCurrentVideoId() === videoId ? cleanVideoTitle(document.querySelector("h1 yt-formatted-string, h1.title, ytd-watch-metadata h1")?.textContent || document.title.replace(" - YouTube", "")) : "";
    if (!isBadVideoTitle(pageTitle)) return pageTitle;

    return `YouTube video ${videoId}`;
  }

  function readPublishedText(card) {
    if (!card) return "";
    const items = Array.from(card.querySelectorAll("#metadata-line span, .inline-metadata-item, .yt-content-metadata-view-model-wiz__metadata-text"));
    for (const node of items) {
      const text = cleanText(node.textContent || "");
      if (/\bago\b/i.test(text) || /streamed|premiered/i.test(text)) return text.replace(/^streamed\s+/i, "").replace(/^premiered\s+/i, "");
    }
    return "";
  }

  function getVideoMetaFromAnchor(anchor) {
    const videoId = getVideoIdFromUrl(anchor.href);
    if (!videoId) return null;

    const card = findCard(anchor);
    const img = card?.querySelector("img") || anchor.querySelector("img");
    const channelNode = card?.querySelector("#channel-name a, ytd-channel-name a, .ytd-channel-name a, .yt-core-attributed-string[href^='/@']");
    const durationNode = card?.querySelector("ytd-thumbnail-overlay-time-status-renderer span, .ytd-thumbnail-overlay-time-status-renderer span, badge-shape .badge-shape-wiz__text");

    return {
      videoId,
      title: getBestTitleFromCard(card, anchor, videoId),
      channelName: cleanText(channelNode?.textContent || "YouTube"),
      thumbnailUrl: img?.src || img?.getAttribute("data-thumb") || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationText: cleanText(durationNode?.textContent || ""),
      publishedText: readPublishedText(card)
    };
  }

  function showToast(message) {
    const existing = document.querySelector(".watchqueue-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `watchqueue-toast ${getThemeClass()}`;
    applyAccent(toast);
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add("watchqueue-toast-visible"), 20);
    setTimeout(() => {
      toast.classList.remove("watchqueue-toast-visible");
      setTimeout(() => toast.remove(), 200);
    }, 1800);
  }

  function showNameDialog({ title = "Name playlist", label = "Playlist name", initialValue = "", confirmText = "Save" } = {}) {
    return new Promise((resolve) => {
      const existing = document.querySelector(".watchqueue-name-dialog");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.className = `watchqueue-name-dialog ${getThemeClass()}`;
      applyAccent(overlay);
      overlay.innerHTML = `
        <div class="watchqueue-name-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="watchqueue-name-header">
            <strong>${escapeHtml(title)}</strong>
            <button type="button" data-action="cancel" aria-label="Close">×</button>
          </div>
          <label>${escapeHtml(label)}</label>
          <input type="text" maxlength="120" value="${escapeHtml(initialValue)}" placeholder="Playlist name" />
          <div class="watchqueue-name-actions">
            <button type="button" data-action="cancel">Cancel</button>
            <button type="button" data-action="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const input = overlay.querySelector("input");
      const cleanup = (value) => {
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) cleanup(null);
      });
      overlay.querySelectorAll("[data-action='cancel']").forEach((button) => button.addEventListener("click", () => cleanup(null)));
      overlay.querySelector("[data-action='confirm']")?.addEventListener("click", () => {
        const value = cleanText(input?.value || "");
        cleanup(value || null);
      });
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const value = cleanText(input.value || "");
          cleanup(value || null);
        }
        if (event.key === "Escape") cleanup(null);
      });
      setTimeout(() => { input?.focus(); input?.select(); }, 20);
    });
  }

  function showConfirmDialog({ title = "Are you sure?", message = "", confirmText = "Confirm", danger = true } = {}) {
    return new Promise((resolve) => {
      const existing = document.querySelector(".watchqueue-name-dialog");
      if (existing) existing.remove();
      const overlay = document.createElement("div");
      overlay.className = `watchqueue-name-dialog ${getThemeClass()}`;
      applyAccent(overlay);
      overlay.innerHTML = `
        <div class="watchqueue-name-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="watchqueue-name-header">
            <strong>${escapeHtml(title)}</strong>
            <button type="button" data-action="cancel" aria-label="Close">×</button>
          </div>
          <p class="watchqueue-confirm-text">${escapeHtml(message)}</p>
          <div class="watchqueue-name-actions">
            <button type="button" data-action="cancel">Cancel</button>
            <button type="button" data-action="confirm" class="${danger ? "watchqueue-danger" : ""}">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = (value) => { overlay.remove(); resolve(value); };
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) cleanup(false); });
      overlay.querySelectorAll("[data-action='cancel']").forEach((button) => button.addEventListener("click", () => cleanup(false)));
      overlay.querySelector("[data-action='confirm']")?.addEventListener("click", () => cleanup(true));
      document.addEventListener("keydown", function onKey(event) {
        if (event.key === "Escape") { document.removeEventListener("keydown", onKey); cleanup(false); }
      });
    });
  }

  function decodeYouTubeText(value) {
    return cleanText(String(value || "")
      .replace(/\\u0026/g, "&")
      .replace(/\\\"/g, '"')
      .replace(/\\n/g, " "));
  }

  function readTextRenderer(value) {
    if (!value) return "";
    if (typeof value === "string") return decodeYouTubeText(value);
    if (value.simpleText) return decodeYouTubeText(value.simpleText);
    if (Array.isArray(value.runs)) return decodeYouTubeText(value.runs.map((run) => run.text || "").join(""));
    return "";
  }

  async function fetchVideoMetadata(videoId) {
    if (!videoId) return null;
    try {
      const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`, { credentials: "omit" });
      if (!response.ok) throw new Error("oEmbed failed");
      const data = await response.json();
      const title = cleanVideoTitle(data.title || "");
      return {
        videoId,
        title: isBadVideoTitle(title) ? `YouTube video ${videoId}` : title,
        channelName: cleanText(data.author_name || "YouTube"),
        thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        durationText: ""
      };
    } catch {
      return null;
    }
  }

  async function improveVideoMetadata(video) {
    if (!video?.videoId || !isBadVideoTitle(video.title)) return video;
    const fetched = await fetchVideoMetadata(video.videoId);
    return fetched || video;
  }

  async function importPlaylistFromUrl(url, fallbackTitle = "Imported playlist", preferProvidedTitle = false) {
    if (!canImportCurrentYouTubePage(url)) {
      throw new Error("Import is only supported on youtube.com/playlist?list= pages or youtube.com/show/ pages");
    }

    const title = cleanText(fallbackTitle || document.title.replace(" - YouTube", "")) || (isShowPage(url) ? "Imported show" : "Imported playlist");

    const response = await chrome.runtime.sendMessage({
      type: "WATCHQUEUE_IMPORT_PLAYLIST",
      url,
      fallbackTitle: title
    });

    if (!response?.ok || !Array.isArray(response.videos) || !response.videos.length) {
      throw new Error(response?.error || "No videos found in playlist");
    }

    // If the caller supplied a known-good name (e.g. from a playlist card or a
    // user-typed dialog), keep it. Otherwise use the scraped playlist title.
    const finalName = preferProvidedTitle && cleanText(fallbackTitle) ? cleanText(fallbackTitle) : (response.title || title);
    const playlist = await WatchQueueManager.createCustomPlaylist(finalName, response.videos);
    return { playlist, addedCount: response.videos.length };
  }

  const metadataRefreshSeen = new Map();
  async function repairBadStoredTitles(state) {
    if (WQ.metadataRepairInFlight) return;
    const badIds = [];
    for (const item of state.queue || []) {
      if (item.videoId && isBadVideoTitle(item.title)) badIds.push(item.videoId);
    }
    for (const playlist of state.playlists || []) {
      for (const item of playlist.videos || []) {
        if (item.videoId && isBadVideoTitle(item.title)) badIds.push(item.videoId);
      }
    }
    const uniqueIds = [...new Set(badIds)].slice(0, 5);
    if (!uniqueIds.length) return;
    WQ.metadataRepairInFlight = true;
    try {
      let changed = false;
      for (const videoId of uniqueIds) {
        const fetched = await fetchVideoMetadata(videoId);
        if (fetched && !isBadVideoTitle(fetched.title)) {
          await WatchQueueManager.updateVideoMetadata(fetched);
          changed = true;
        }
      }
      if (changed && WQ.panel && !WQ.panel.hidden) await renderPanel();
    } finally {
      WQ.metadataRepairInFlight = false;
    }
  }

  async function refreshQueuedVideoMetadata(video) {
    if (!video?.videoId) return;
    const last = metadataRefreshSeen.get(video.videoId) || 0;
    if (Date.now() - last < 20000) return;
    metadataRefreshSeen.set(video.videoId, Date.now());
    const state = await WatchQueueStorage.getState();
    const item = state.queue.find((queueItem) => queueItem.videoId === video.videoId);
    const hasBadQueueTitle = item && isBadVideoTitle(item.title);
    const playlistNeedsTitle = (state.playlists || []).some((playlist) => (playlist.videos || []).some((entry) => entry.videoId === video.videoId && isBadVideoTitle(entry.title)));
    const visibleTitleIsGood = video.title && !isBadVideoTitle(video.title);
    if ((hasBadQueueTitle || playlistNeedsTitle) && visibleTitleIsGood) {
      await WatchQueueManager.updateVideoMetadata(video);
      return;
    }
    if (hasBadQueueTitle || playlistNeedsTitle) {
      const fetched = await fetchVideoMetadata(video.videoId);
      if (fetched) await WatchQueueManager.updateVideoMetadata(fetched);
    }
  }

  function isInsidePlaylistHeader(anchor) {
    const text = cleanText(anchor.textContent || anchor.getAttribute("aria-label") || "").toLowerCase();
    return text === "play all" || text.includes("play all") || Boolean(anchor.closest("ytd-playlist-header-renderer, ytd-playlist-sidebar-renderer"));
  }

  function getButtonHost(card, anchor, isPlaylist = false) {
    const selectors = isPlaylist
      ? "yt-collection-thumbnail-view-model, ytd-playlist-thumbnail, ytd-thumbnail, yt-thumbnail-view-model, #thumbnail"
      : "ytd-thumbnail, yt-thumbnail-view-model, #thumbnail";
    return card?.querySelector(selectors) || anchor.querySelector(selectors) || anchor;
  }

  function getPlaylistPanelVideoMeta(row) {
    const anchor = row?.querySelector?.('a[href*="/watch?v="]');
    if (!anchor) return null;
    const videoId = getVideoIdFromUrl(anchor.href);
    if (!videoId) return null;
    const img = row.querySelector("img");
    const titleNode = row.querySelector("#video-title, .playlist-items #video-title, yt-formatted-string[id='video-title'], a[href*='/watch'][title]") || anchor;
    const title = cleanVideoTitle(titleNode?.getAttribute?.("title") || titleNode?.textContent || anchor.getAttribute("title") || anchor.getAttribute("aria-label") || `YouTube video ${videoId}`);
    const channelNode = row.querySelector("#byline, ytd-channel-name, .ytd-channel-name, #channel-name");
    const durationNode = row.querySelector("#text.ytd-thumbnail-overlay-time-status-renderer, ytd-thumbnail-overlay-time-status-renderer span, .badge-shape-wiz__text");
    return {
      videoId,
      title: isBadVideoTitle(title) ? `YouTube video ${videoId}` : title,
      channelName: cleanText(channelNode?.textContent || "YouTube"),
      thumbnailUrl: img?.src || img?.getAttribute("data-thumb") || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationText: cleanText(durationNode?.textContent || ""),
      publishedText: readPublishedText(row)
    };
  }

  function collectPlaylistPanelVideosFromDom(panel) {
    const videos = new Map();
    const rows = Array.from(panel?.querySelectorAll?.("ytd-playlist-panel-video-renderer, ytd-playlist-video-renderer, a[href*='/watch?v=']") || []);
    for (const row of rows) {
      const host = row.matches?.("a[href*='/watch?v=']") ? row.closest("ytd-playlist-panel-video-renderer, ytd-playlist-video-renderer") || row : row;
      const meta = getPlaylistPanelVideoMeta(host);
      if (meta?.videoId && !videos.has(meta.videoId)) videos.set(meta.videoId, meta);
    }
    return [...videos.values()];
  }

  // Safely place a node in a container without the insertBefore "not a child" crash.
  function safeInsert(container, node, reference) {
    if (!container || !node) return;
    if (reference && reference.parentNode === container) {
      if (node !== reference && node.nextSibling !== reference) container.insertBefore(node, reference);
    } else if (node.parentNode !== container) {
      container.appendChild(node);
    }
  }

  // Import the playlist that the current watch page belongs to (via ?list=), using the background worker.
  async function importCurrentWatchPlaylist() {
    const list = getPlaylistIdFromUrl(window.location.href);
    if (!list) { showToast("No playlist on this page"); return; }
    const panel = document.querySelector("ytd-playlist-panel-renderer");
    const suggested = cleanText(
      panel?.querySelector("#header .title a, #header .title, #header yt-formatted-string.title, #playlist-title, .index-message-wrapper + a, h3 a")?.textContent
      || panel?.querySelector("#header a[href*='/playlist']")?.textContent
      || ""
    );
    const name = await showNameDialog({ title: "Save playlist", label: "WatchQueue playlist name", initialValue: suggested, confirmText: "Save playlist" });
    if (!name) return;
    showToast("Saving playlist…");
    try {
      const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
      const result = await importPlaylistFromUrl(url, name, true);
      WQ.activeTab = "playlists";
      WQ.selectedPlaylistId = result.playlist.id;
      await renderWidget();
      if (WQ.panel && !WQ.panel.hidden) await renderPanel();
      showToast(`Saved playlist with ${result.addedCount} videos`);
    } catch {
      const videos = panel ? collectPlaylistPanelVideosFromDom(panel) : [];
      if (!videos.length) { showToast("Could not import this playlist"); return; }
      const repaired = [];
      for (const video of videos) repaired.push(await improveVideoMetadata(video));
      const playlist = await WatchQueueManager.createCustomPlaylist(name, repaired);
      WQ.activeTab = "playlists";
      WQ.selectedPlaylistId = playlist.id;
      await renderWidget();
      if (WQ.panel && !WQ.panel.hidden) await renderPanel();
      showToast(`Saved playlist with ${repaired.length} videos`);
    }
  }

  function makeImportButton({ className, onClick, label = "+ Playlist" }) {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.title = "Save this playlist into WatchQueue";
    button.textContent = label;
    applyAccent(button);
    button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); onClick(); });
    return button;
  }

  function findPlaylistPanelImportSlot(panel) {
    const actions = panel.querySelector("#playlist-actions")
      || panel.querySelector("#header #actions")
      || panel.querySelector("#header ytd-menu-renderer")
      || panel.querySelector("#header");
    return actions || null;
  }

  // Side-panel button: scrapes the currently visible playlist-panel videos.
  function createPlaylistPanelImportButton(panel) {
    return makeImportButton({
      className: "watchqueue-panel-playlist-import",
      onClick: async () => {
        const videos = collectPlaylistPanelVideosFromDom(panel);
        if (!videos.length) { showToast("No playlist videos found yet"); return; }
        const name = await showNameDialog({ title: "Save playlist", label: "Choose a WatchQueue playlist name", initialValue: "YouTube playlist", confirmText: "Save playlist" });
        if (!name) return;
        const repaired = [];
        for (const video of videos) repaired.push(await improveVideoMetadata(video));
        const playlist = await WatchQueueManager.createCustomPlaylist(name, repaired);
        WQ.activeTab = "playlists";
        WQ.selectedPlaylistId = playlist.id;
        await renderWidget();
        if (WQ.panel && !WQ.panel.hidden) await renderPanel();
        showToast(`Saved playlist with ${repaired.length} videos`);
      }
    });
  }

  function injectWatchActionsImportButton() {
    // Remove any strays first so we never accumulate duplicates.
    const keepButtons = new Set();
    // Only on watch pages that belong to a playlist.
    if (getPlaylistIdFromUrl(window.location.href)) {
      // The primary video action bar lives under ytd-watch-metadata. We must NOT
      // target #top-level-buttons-computed that live inside the playlist side panel
      // (those are a different ytd-menu-renderer and caused duplicate buttons).
      const metadata = document.querySelector("ytd-watch-metadata, #above-the-fold");
      const container = metadata
        ? metadata.querySelector("#top-level-buttons-computed")
        : document.querySelector("ytd-watch-metadata #top-level-buttons-computed");
      if (container && !container.closest("ytd-playlist-panel-renderer")) {
        let button = container.querySelector(".watchqueue-watch-actions-import");
        if (!button) {
          container.classList.add("watchqueue-watch-actions-host");
          button = makeImportButton({ className: "watchqueue-watch-actions-import", onClick: importCurrentWatchPlaylist });
          container.appendChild(button);
        } else {
          applyAccent(button);
        }
        keepButtons.add(button);
      }
    }
    // Drop any watch-actions buttons that ended up anywhere else (e.g. playlist panel).
    document.querySelectorAll(".watchqueue-watch-actions-import").forEach((button) => {
      if (!keepButtons.has(button)) button.remove();
    });
  }

  async function injectPlaylistPanelImportButton() {
    // 1) Playlist side-panel
    const panels = Array.from(document.querySelectorAll("ytd-playlist-panel-renderer"));
    for (const panel of panels) {
      const container = findPlaylistPanelImportSlot(panel);
      if (!container) continue;
      container.classList.add("watchqueue-playlist-actions-host");
      let button = panel.querySelector(".watchqueue-panel-playlist-import");
      if (!button) button = createPlaylistPanelImportButton(panel);
      else applyAccent(button);
      // Stable, crash-free placement: keep it as the last child of the actions row.
      safeInsert(container, button, null);
    }
    // 2) Watch-page action bar (#top-level-buttons-computed) beside the toggle button
    injectWatchActionsImportButton();
  }

  function cleanupMisplacedQueueButtons() {
    document.querySelectorAll(".watchqueue-add-button:not(.watchqueue-list-add-button)").forEach((button) => {
      const host = button.parentElement;
      const isThumbnailHost = Boolean(host?.matches?.("ytd-thumbnail, yt-thumbnail-view-model, #thumbnail, a#thumbnail") || host?.querySelector?.("img, ytd-thumbnail, yt-thumbnail-view-model"));
      if (!isThumbnailHost) button.remove();
    });
  }

  function removeAllThumbnailButtons() {
    document.querySelectorAll(".watchqueue-add-button:not(.watchqueue-list-add-button)").forEach((button) => button.remove());
  }

  function removeAllListButtons() {
    document.querySelectorAll(".watchqueue-list-add-button").forEach((button) => button.remove());
  }

  // Detect a playlist ("view full playlist") or show link on a card.
  function getImportUrlFromCard(card) {
    const isPlaylistCard = Boolean(
      card.matches?.("ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, ytd-radio-renderer, ytd-compact-radio-renderer")
      || card.querySelector?.("yt-collection-thumbnail-view-model, ytd-playlist-thumbnail, ytd-thumbnail-overlay-bottom-panel-renderer, .yt-thumbnail-overlay-badge-view-model")
    );
    const anchors = card.querySelectorAll("a[href]");
    for (const anchor of anchors) {
      try {
        const url = new URL(anchor.href, window.location.origin);
        if (url.pathname.startsWith("/show/")) return { url: url.toString(), kind: "show" };
        const list = url.searchParams.get("list");
        if (url.pathname === "/playlist" && list) {
          return { url: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`, kind: "playlist" };
        }
        // Playlist cards sometimes link to the first video with a &list= param.
        if (isPlaylistCard && url.pathname === "/watch" && list && !/^RD|^UL|^LL|^WL/.test(list)) {
          return { url: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`, kind: "playlist" };
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  async function injectChannelPlaylistButtons() {
    if (settings().showThumbnailButtons === false) { removeAllListButtons(); return; }
    const cards = document.querySelectorAll("ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, ytd-rich-item-renderer, yt-lockup-view-model");
    for (const card of cards) {
      const target = getImportUrlFromCard(card);
      if (!target) continue;
      const host = getButtonHost(card, card, true);
      if (!host || host.querySelector(".watchqueue-list-add-button")) continue;
      host.classList.add("watchqueue-thumbnail-host");
      const button = document.createElement("button");
      button.className = "watchqueue-add-button watchqueue-list-add-button";
      button.type = "button";
      button.title = target.kind === "show" ? "Import this show into WatchQueue" : "Import this playlist into WatchQueue";
      button.innerHTML = `<span class="watchqueue-add-plus">+</span><span>List</span>`;
      applyAccent(button);
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const suggested = cleanText(card.querySelector("#video-title, .yt-lockup-metadata-view-model-wiz__title, yt-formatted-string#video-title, h3, #title")?.textContent) || (target.kind === "show" ? "Imported show" : "Imported playlist");
        showToast(target.kind === "show" ? "Importing show…" : "Importing playlist…");
        try {
          const result = await importPlaylistFromUrl(target.url, suggested, target.kind === "playlist");
          WQ.selectedPlaylistId = result.playlist.id;
          WQ.activeTab = "playlists";
          await renderWidget();
          if (WQ.panel && !WQ.panel.hidden) await renderPanel();
          showToast(`Imported ${result.addedCount} videos`);
        } catch {
          showToast("Could not import this yet");
        }
      });
      host.appendChild(button);
    }
  }

  async function injectThumbnailButtons() {
    await injectPlaylistPanelImportButton();
    if (settings().showThumbnailButtons === false) {
      removeAllThumbnailButtons();
      removeAllListButtons();
      return;
    }
    cleanupMisplacedQueueButtons();
    await injectChannelPlaylistButtons();
    if (isChannelPlaylistsPage()) {
      // Playlist listing pages show playlist cards, not individual videos:
      // keep the "+ List" buttons, drop any stray per-video "+ Queue" buttons.
      removeAllThumbnailButtons();
      return;
    }

    const videoAnchors = Array.from(document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]'));
    for (const anchor of videoAnchors) {
      const isThumbnailAnchor = anchor.matches("a#thumbnail, a.ytd-thumbnail, a[href*='/shorts/']:has(img)") || Boolean(anchor.querySelector("img, ytd-thumbnail, yt-thumbnail-view-model, #thumbnail"));
      if (!isThumbnailAnchor) continue;
      if (isInsidePlaylistHeader(anchor)) continue;
      const video = getVideoMetaFromAnchor(anchor);
      if (!video) continue;
      const card = findCard(anchor);
      if (!card) continue;
      refreshQueuedVideoMetadata(video);
      if (card.querySelector(`.watchqueue-add-button[data-video-id="${video.videoId}"]`)) continue;
      const thumbnail = getButtonHost(card, anchor, false);
      if (!thumbnail) continue;
      thumbnail.classList.add("watchqueue-thumbnail-host");
      const button = document.createElement("button");
      button.className = "watchqueue-add-button";
      button.dataset.videoId = video.videoId;
      button.type = "button";
      button.title = "Add to WatchQueue";
      button.innerHTML = `<span class="watchqueue-add-plus">+</span><span>Queue</span>`;
      applyAccent(button);
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        let latestVideo = getVideoMetaFromAnchor(anchor) || video;
        latestVideo = await improveVideoMetadata(latestVideo);
        const added = await WatchQueueManager.addVideo(latestVideo);
        await renderWidget();
        showToast(added?.wasDuplicate ? "Already in WatchQueue" : "Added to WatchQueue");
      });
      thumbnail.appendChild(button);
    }
  }

  async function navigateToVideo(item) {
    if (!item?.videoId) return;
    const state = await WatchQueueStorage.getState();
    const progress = state.progress?.[item.videoId] || {};
    const mergedItem = {
      ...item,
      lastWatchedSeconds: progress.lastWatchedSeconds ?? item.lastWatchedSeconds ?? 0,
      completed: progress.completed ?? item.completed ?? false
    };
    const resumeSeconds = getResumeSeconds(mergedItem);
    const currentVideoId = getCurrentVideoId();
    const video = document.querySelector("video");
    if (currentVideoId === item.videoId && video) {
      if (resumeSeconds > 0) video.currentTime = resumeSeconds;
      await video.play().catch(() => {});
      return;
    }
    const url = new URL("https://www.youtube.com/watch");
    url.searchParams.set("v", item.videoId);
    if (resumeSeconds > 0) url.searchParams.set("t", `${resumeSeconds}s`);
    window.location.assign(url.toString());
  }

  function formatTime(seconds) {
    if (!seconds || seconds <= 0) return "0:00";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
    if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, "0")}:${secs}`;
    return `${mins}:${secs}`;
  }

  function totalQueueDurationText(queue) {
    const total = queue.reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0);
    if (total <= 0) return "";
    return formatTime(total);
  }

  const WIDGET_EDGES = ["left", "right", "top", "bottom"];

  function isHorizontalEdge(edge) {
    return edge === "top" || edge === "bottom";
  }

  function getDefaultWidgetPosition() {
    const edge = WIDGET_EDGES.includes(settings().widgetEdge) ? settings().widgetEdge : "right";
    return {
      edge,
      offset: isHorizontalEdge(edge) ? Math.round(window.innerWidth * 0.5) : Math.max(72, Math.round(window.innerHeight * 0.46))
    };
  }

  function normalizeWidgetPosition(position) {
    let edge = WIDGET_EDGES.includes(position?.edge)
      ? position.edge
      : WIDGET_EDGES.includes(position?.side)
        ? position.side
        : (WIDGET_EDGES.includes(settings().widgetEdge) ? settings().widgetEdge : "right");
    const horizontal = isHorizontalEdge(edge);
    let offset = Number(position?.offset);
    if (!Number.isFinite(offset)) offset = horizontal ? Number(position?.x) : Number(position?.y);
    if (!Number.isFinite(offset)) offset = horizontal ? window.innerWidth * 0.5 : window.innerHeight * 0.46;
    const limit = horizontal ? window.innerWidth - 96 : window.innerHeight - 96;
    offset = Math.min(Math.max(16, offset), Math.max(16, limit));
    return { edge, offset };
  }

  function positionWidget(position) {
    if (!WQ.widget) return;
    const next = normalizeWidgetPosition(position);
    WQ.widget.dataset.edge = next.edge;
    WQ.widget.dataset.side = next.edge; // legacy CSS hooks
    const style = WQ.widget.style;
    style.top = style.bottom = style.left = style.right = "auto";
    style.transform = "none";
    if (isHorizontalEdge(next.edge)) {
      style.left = `${next.offset}px`;
      style[next.edge] = "0px";
    } else {
      style.top = `${next.offset}px`;
      style[next.edge] = "0px";
    }
    positionPanelBesideWidget();
  }

  function positionPanelBesideWidget() {
    if (!WQ.widget || !WQ.panel) return;
    const edge = WQ.widget.dataset.edge || "right";
    const rect = WQ.widget.getBoundingClientRect();
    const gap = 14;
    const panelWidth = Math.min(PANEL_WIDTH, Math.max(280, window.innerWidth - 2 * PANEL_MARGIN));
    const panelHeight = Math.min(PANEL_HEIGHT, Math.max(260, window.innerHeight - PANEL_MARGIN * 2));

    const style = WQ.panel.style;
    style.top = style.bottom = style.left = style.right = "auto";
    style.transform = "none";
    style.width = `${panelWidth}px`;
    style.height = `${panelHeight}px`;

    WQ.panel.classList.remove("watchqueue-panel-open-left", "watchqueue-panel-open-right", "watchqueue-panel-open-up", "watchqueue-panel-open-down");

    const clampX = (x) => Math.min(Math.max(PANEL_MARGIN, x), Math.max(PANEL_MARGIN, window.innerWidth - panelWidth - PANEL_MARGIN));
    const clampY = (y) => Math.min(Math.max(PANEL_MARGIN, y), Math.max(PANEL_MARGIN, window.innerHeight - panelHeight - PANEL_MARGIN));

    if (edge === "left" || edge === "right") {
      const top = clampY(rect.top + rect.height / 2 - panelHeight / 2);
      style.top = `${top}px`;
      if (edge === "left") { style.left = `${Math.round(rect.right + gap)}px`; WQ.panel.classList.add("watchqueue-panel-open-right"); }
      else { style.left = `${clampX(rect.left - gap - panelWidth)}px`; WQ.panel.classList.add("watchqueue-panel-open-left"); }
    } else {
      const left = clampX(rect.left + rect.width / 2 - panelWidth / 2);
      style.left = `${left}px`;
      if (edge === "top") { style.top = `${Math.round(rect.bottom + gap)}px`; WQ.panel.classList.add("watchqueue-panel-open-down"); }
      else { style.top = `${clampY(rect.top - gap - panelHeight)}px`; WQ.panel.classList.add("watchqueue-panel-open-up"); }
    }
  }

  function nearestEdgeFromPoint(x, y) {
    const distances = {
      left: x,
      right: window.innerWidth - x,
      top: y,
      bottom: window.innerHeight - y
    };
    return Object.keys(distances).reduce((best, edge) => (distances[edge] < distances[best] ? edge : best), "right");
  }

  function attachWidgetDragHandlers(orb) {
    orb.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      WQ.dragStart = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, edge: WQ.widget.dataset.edge || "right" };
      WQ.isDraggingWidget = true;
      orb.setPointerCapture?.(event.pointerId);
    });

    orb.addEventListener("pointermove", (event) => {
      if (!WQ.isDraggingWidget || !WQ.dragStart) return;
      const dx = event.clientX - WQ.dragStart.startX;
      const dy = event.clientY - WQ.dragStart.startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) WQ.dragStart.moved = true;
      const edge = nearestEdgeFromPoint(event.clientX, event.clientY);
      const offset = isHorizontalEdge(edge) ? event.clientX : event.clientY;
      positionWidget({ edge, offset });
    });

    orb.addEventListener("pointerup", async (event) => {
      if (!WQ.isDraggingWidget || !WQ.dragStart) return;
      orb.releasePointerCapture?.(event.pointerId);
      WQ.isDraggingWidget = false;
      const moved = WQ.dragStart.moved;
      WQ.dragStart = null;
      if (moved) {
        WQ.suppressNextOrbClick = true;
        const edge = WQ.widget.dataset.edge || "right";
        const rect = WQ.widget.getBoundingClientRect();
        const offset = isHorizontalEdge(edge) ? rect.left : rect.top;
        await WatchQueueManager.saveWidgetPosition({ edge, offset });
        if (settings().widgetEdge !== edge) await WatchQueueManager.updateSettings({ widgetEdge: edge });
        await loadSettings();
        // keep the Settings tab's edge selector in sync with a manual drag
        if (WQ.panel && !WQ.panel.hidden && WQ.activeTab === "settings") await renderPanel();
        setTimeout(() => { WQ.suppressNextOrbClick = false; }, 0);
      }
    });

    orb.addEventListener("pointercancel", () => { WQ.isDraggingWidget = false; WQ.dragStart = null; });
  }

  async function renderWidget() {
    const state = await WatchQueueStorage.getState();
    WQ.settings = { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(state.settings || {}) };
    const wasOpen = WQ.panel ? !WQ.panel.hidden : WQ.userOpenedPanel;
    if (state.widgetHidden) {
      if (WQ.widget) WQ.widget.remove();
      WQ.widget = null;
      WQ.panel = null;
      return;
    }
    if (!WQ.widget) {
      WQ.widget = document.createElement("div");
      document.body.appendChild(WQ.widget);
    }
    WQ.widget.className = `watchqueue-widget ${getThemeClass()} ${widgetStyleClass()}`;
    applyAccent(WQ.widget);
    WQ.widget.innerHTML = `
      <button class="watchqueue-orb" type="button" aria-label="Open WatchQueue" title="Drag to any edge. Click to open WatchQueue">
        <span class="watchqueue-orb-mark"><span class="watchqueue-orb-icon">▶</span></span>
        <span class="watchqueue-orb-label">Queue</span>
        <span class="watchqueue-count" ${state.queue.length ? "" : "hidden"}>${state.queue.length}</span>
      </button>
      <button class="watchqueue-widget-hide" type="button" aria-label="Hide WatchQueue" title="Hide widget. Click the extension icon to bring it back.">×</button>
      <section class="watchqueue-panel" hidden></section>`;
    WQ.panel = WQ.widget.querySelector(".watchqueue-panel");
    const orb = WQ.widget.querySelector(".watchqueue-orb");
    const hideButton = WQ.widget.querySelector(".watchqueue-widget-hide");
    hideButton?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await WatchQueueManager.setWidgetHidden(true);
      await renderWidget();
      showToast("WatchQueue hidden. Click the extension icon to show it again.");
    });
    attachWidgetDragHandlers(orb);
    positionWidget(state.widgetPosition || getDefaultWidgetPosition());
    orb.addEventListener("click", async () => {
      if (WQ.suppressNextOrbClick) return;
      WQ.userOpenedPanel = WQ.panel.hidden;
      WQ.panel.hidden = !WQ.panel.hidden;
      positionPanelBesideWidget();
      if (!WQ.panel.hidden) await renderPanel();
    });
    if (wasOpen) {
      WQ.userOpenedPanel = true;
      WQ.panel.hidden = false;
      positionPanelBesideWidget();
      await renderPanel();
    }
    updateFullscreenVisibility();
  }

  // ---------- settings tab rendering ----------
  function sliderControl(key, labelText, min, max, value, suffix = "s") {
    return `<div class="watchqueue-setting">
      <div class="watchqueue-setting-top"><label>${escapeHtml(labelText)}</label><span class="watchqueue-setting-value" data-value-for="${key}">${value}${suffix}</span></div>
      <input class="watchqueue-range" type="range" min="${min}" max="${max}" step="1" value="${value}" data-setting-range="${key}" data-suffix="${escapeHtml(suffix)}" />
    </div>`;
  }

  function toggleControl(key, labelText, checked, description = "") {
    return `<div class="watchqueue-setting watchqueue-setting-toggle">
      <div class="watchqueue-setting-text"><label>${escapeHtml(labelText)}</label>${description ? `<span class="watchqueue-setting-desc">${escapeHtml(description)}</span>` : ""}</div>
      <label class="watchqueue-switch watchqueue-switch-compact"><input type="checkbox" ${checked ? "checked" : ""} data-setting-toggle="${key}" /><span class="watchqueue-slider"></span></label>
    </div>`;
  }

  function buildSettingsPage(state) {
    const s = WQ.settings;
    const themeButtons = ["auto", "light", "dark"].map((option) =>
      `<button type="button" class="${s.theme === option ? "active" : ""}" data-setting-theme="${option}">${option.charAt(0).toUpperCase() + option.slice(1)}</button>`
    ).join("");

    const currentAccent = (s.accent || "#ff0033").toLowerCase();
    const isPreset = ACCENT_SWATCHES.some((color) => color.toLowerCase() === currentAccent);
    const customSwatch = `<label class="watchqueue-swatch watchqueue-swatch-custom ${isPreset ? "" : "active"}" title="Custom color" style="--wq-custom:${escapeHtml(isPreset ? currentAccent : currentAccent)}">
      <input type="color" value="${escapeHtml(currentAccent)}" data-setting-accent-custom aria-label="Custom accent color" />
      <span class="watchqueue-swatch-custom-mark">✎</span>
    </label>`;
    const swatches = ACCENT_SWATCHES.map((color) =>
      `<button type="button" class="watchqueue-swatch ${currentAccent === color.toLowerCase() ? "active" : ""}" style="background:${color}" data-setting-accent="${color}" aria-label="Accent ${color}"></button>`
    ).join("");

    const edgeButtons = ["left", "right", "top", "bottom"].map((option) =>
      `<button type="button" class="${(s.widgetEdge || "right") === option ? "active" : ""}" data-setting-edge="${option}">${option.charAt(0).toUpperCase() + option.slice(1)}</button>`
    ).join("");
    const styleButtons = [["pill", "Pill"], ["tab", "Tab"]].map(([value, labelText]) =>
      `<button type="button" class="${(s.widgetStyle || "pill") === value ? "active" : ""}" data-setting-widgetstyle="${value}">${labelText}</button>`
    ).join("");

    return `
      <div class="watchqueue-settings-scroll">
        <div class="watchqueue-settings-group">
          <h4>Appearance</h4>
          <div class="watchqueue-setting">
            <div class="watchqueue-setting-top"><label>Theme</label></div>
            <div class="watchqueue-segmented" data-segmented="theme">${themeButtons}</div>
          </div>
          <div class="watchqueue-setting">
            <div class="watchqueue-setting-top"><label>Accent color</label></div>
            <div class="watchqueue-swatches">${customSwatch}${swatches}</div>
          </div>
          ${sliderControl("panelOpacity", "Panel opacity", 40, 100, num(s.panelOpacity, 100), "%")}
        </div>

        <div class="watchqueue-settings-group">
          <h4>Floating widget</h4>
          <div class="watchqueue-setting">
            <div class="watchqueue-setting-top"><label>Dock to edge</label></div>
            <div class="watchqueue-segmented watchqueue-segmented-quad" data-segmented="edge">${edgeButtons}</div>
          </div>
          <div class="watchqueue-setting">
            <div class="watchqueue-setting-top"><label>Widget style</label></div>
            <div class="watchqueue-segmented" data-segmented="widgetstyle">${styleButtons}</div>
          </div>
          <span class="watchqueue-setting-desc">Tip: you can also drag the widget to any edge.</span>
        </div>

        <div class="watchqueue-settings-group">
          <h4>Playback &amp; resume</h4>
          ${sliderControl("resumeRewindSeconds", "Rewind before resuming", 0, 30, num(s.resumeRewindSeconds, 7))}
          ${sliderControl("minResumeSeconds", "Only resume after watching", 5, 120, num(s.minResumeSeconds, 15))}
        </div>

        <div class="watchqueue-settings-group">
          <h4>Auto-next</h4>
          ${sliderControl("autoNextDelaySeconds", "Delay before next video", 0, 30, num(s.autoNextDelaySeconds, 10))}
          ${toggleControl("autoNextNearEnd", "Trigger near the end", s.autoNextNearEnd !== false, "Start the countdown when you scrub close to the end.")}
          ${sliderControl("nearEndSeconds", "Near-end window", 3, 30, num(s.nearEndSeconds, 10))}
          ${toggleControl("loopQueue", "Loop queue", Boolean(s.loopQueue), "Wrap back to the top when the queue ends.")}
          ${toggleControl("autoRemoveWatched", "Auto-remove watched", Boolean(s.autoRemoveWatched), "Drop videos from the queue once finished.")}
        </div>

        <div class="watchqueue-settings-group">
          <h4>Interface</h4>
          ${toggleControl("showThumbnailButtons", "Show + Queue on thumbnails", s.showThumbnailButtons !== false, "Hover buttons on YouTube thumbnails.")}
          ${toggleControl("confirmClear", "Confirm before clearing", s.confirmClear !== false, "Ask before emptying the whole queue.")}
        </div>

        <div class="watchqueue-settings-group">
          <h4>Backup &amp; data</h4>
          <div class="watchqueue-settings-buttons">
            <button type="button" data-action="export-data">Export backup</button>
            <button type="button" data-action="import-data">Import backup</button>
          </div>
          <div class="watchqueue-settings-buttons">
            <button type="button" data-action="reset-widget-position">Reset widget position</button>
            <button type="button" data-action="reset-settings" class="watchqueue-danger-outline">Reset settings</button>
          </div>
        </div>

        <div class="watchqueue-settings-footer">WatchQueue · your queue, playlists and settings stay on this device.</div>
      </div>`;
  }

  function exportBackup(state) {
    const payload = {
      app: "WatchQueue",
      version: 3,
      exportedAt: new Date().toISOString(),
      queue: state.queue || [],
      playlists: state.playlists || [],
      progress: state.progress || {},
      settings: state.settings || {}
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `watchqueue-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function importBackup() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || (!Array.isArray(data.queue) && !Array.isArray(data.playlists))) {
          showToast("That doesn't look like a WatchQueue backup");
          return;
        }
        await WatchQueueStorage.updateState((current) => ({
          ...current,
          queue: Array.isArray(data.queue) ? data.queue : current.queue,
          playlists: Array.isArray(data.playlists) ? data.playlists : current.playlists,
          progress: data.progress && typeof data.progress === "object" ? { ...current.progress, ...data.progress } : current.progress,
          settings: { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(current.settings || {}), ...(data.settings || {}) }
        }));
        await loadSettings();
        await renderWidget();
        if (WQ.panel && !WQ.panel.hidden) await renderPanel();
        showToast("Backup imported");
      } catch {
        showToast("Could not read that backup file");
      }
    });
    input.click();
  }

  function bindSettingsHandlers(state) {
    // theme segmented
    WQ.panel.querySelectorAll("[data-setting-theme]").forEach((button) => {
      button.addEventListener("click", async () => {
        await WatchQueueManager.updateSettings({ theme: button.dataset.settingTheme });
        await loadSettings();
        applyWidgetChrome();
        await renderPanel();
      });
    });
    // preset accent swatches
    WQ.panel.querySelectorAll("[data-setting-accent]").forEach((button) => {
      button.addEventListener("click", async () => {
        await WatchQueueManager.updateSettings({ accent: button.dataset.settingAccent });
        await loadSettings();
        applyWidgetChrome();
        if (WQ.panel) applyAccent(WQ.panel);
        await renderPanel();
      });
    });
    // custom accent color picker
    const customAccent = WQ.panel.querySelector("[data-setting-accent-custom]");
    if (customAccent) {
      const previewCustom = (value) => {
        const label = customAccent.closest(".watchqueue-swatch-custom");
        if (label) label.style.setProperty("--wq-custom", value);
        if (WQ.widget) applyAccent(WQ.widget);
        if (WQ.panel) applyAccent(WQ.panel);
      };
      customAccent.addEventListener("input", () => previewCustom(customAccent.value));
      customAccent.addEventListener("change", async () => {
        await WatchQueueManager.updateSettings({ accent: customAccent.value });
        await loadSettings();
        applyWidgetChrome();
        if (WQ.panel) applyAccent(WQ.panel);
        await renderPanel();
      });
    }
    // widget edge
    WQ.panel.querySelectorAll("[data-setting-edge]").forEach((button) => {
      button.addEventListener("click", async () => {
        const edge = button.dataset.settingEdge;
        const offset = (edge === "top" || edge === "bottom") ? Math.round(window.innerWidth * 0.5) : Math.max(72, Math.round(window.innerHeight * 0.46));
        await WatchQueueManager.updateSettings({ widgetEdge: edge });
        await WatchQueueManager.saveWidgetPosition({ edge, offset });
        await loadSettings();
        applyWidgetChrome();
        const fresh = await WatchQueueStorage.getState();
        positionWidget(fresh.widgetPosition || getDefaultWidgetPosition());
        await renderPanel();
      });
    });
    // widget style
    WQ.panel.querySelectorAll("[data-setting-widgetstyle]").forEach((button) => {
      button.addEventListener("click", async () => {
        await WatchQueueManager.updateSettings({ widgetStyle: button.dataset.settingWidgetstyle });
        await loadSettings();
        applyWidgetChrome();
        const fresh = await WatchQueueStorage.getState();
        positionWidget(fresh.widgetPosition || getDefaultWidgetPosition());
        await renderPanel();
      });
    });
    // range sliders (live value label, save on release)
    WQ.panel.querySelectorAll("[data-setting-range]").forEach((range) => {
      const key = range.dataset.settingRange;
      const suffix = range.dataset.suffix || "s";
      const label = WQ.panel.querySelector(`[data-value-for="${key}"]`);
      range.addEventListener("input", () => {
        if (label) label.textContent = `${range.value}${suffix}`;
        if (key === "panelOpacity") {
          // live preview of panel opacity while dragging
          WQ.settings.panelOpacity = Number(range.value);
          if (WQ.panel) applyAccent(WQ.panel);
          if (WQ.widget) applyAccent(WQ.widget);
        }
      });
      range.addEventListener("change", async () => {
        await WatchQueueManager.updateSettings({ [key]: Number(range.value) });
        await loadSettings();
        if (key === "panelOpacity") { if (WQ.panel) applyAccent(WQ.panel); if (WQ.widget) applyAccent(WQ.widget); }
      });
    });
    // toggles
    WQ.panel.querySelectorAll("[data-setting-toggle]").forEach((toggle) => {
      toggle.addEventListener("change", async () => {
        const key = toggle.dataset.settingToggle;
        await WatchQueueManager.updateSettings({ [key]: toggle.checked });
        await loadSettings();
        if (key === "showThumbnailButtons") await injectThumbnailButtons();
      });
    });
    // data buttons
    WQ.panel.querySelector("[data-action='export-data']")?.addEventListener("click", async () => {
      const fresh = await WatchQueueStorage.getState();
      exportBackup(fresh);
      showToast("Backup downloaded");
    });
    WQ.panel.querySelector("[data-action='import-data']")?.addEventListener("click", () => importBackup());
    WQ.panel.querySelector("[data-action='reset-widget-position']")?.addEventListener("click", async () => {
      await WatchQueueManager.saveWidgetPosition(getDefaultWidgetPosition());
      const fresh = await WatchQueueStorage.getState();
      positionWidget(fresh.widgetPosition || getDefaultWidgetPosition());
      showToast("Widget position reset");
    });
    WQ.panel.querySelector("[data-action='reset-settings']")?.addEventListener("click", async () => {
      const ok = await showConfirmDialog({ title: "Reset settings", message: "Restore all settings to their defaults? Your queue and playlists are kept.", confirmText: "Reset" });
      if (!ok) return;
      await WatchQueueManager.resetSettings();
      await loadSettings();
      applyWidgetChrome();
      const fresh = await WatchQueueStorage.getState();
      positionWidget(fresh.widgetPosition || getDefaultWidgetPosition());
      if (WQ.panel) applyAccent(WQ.panel);
      await renderPanel();
      showToast("Settings reset to defaults");
    });
  }

  function applyQueueFilter() {
    if (!WQ.panel) return;
    const list = WQ.panel.querySelector(".watchqueue-list");
    if (!list) return;
    const term = (WQ.queueSearch || "").trim().toLowerCase();
    const rows = Array.from(list.querySelectorAll(".watchqueue-row"));
    let visibleCount = 0;
    rows.forEach((row) => {
      const key = row.dataset.search || "";
      const match = !term || key.includes(term);
      row.hidden = !match;
      // disable drag while filtering so indices can't desync
      row.setAttribute("draggable", term ? "false" : "true");
      if (match) visibleCount += 1;
    });
    const noMatch = list.querySelector(".watchqueue-no-match");
    if (noMatch) noMatch.hidden = !(term && rows.length && visibleCount === 0);
  }

  async function renderPanel() {
    const state = await WatchQueueStorage.getState();
    WQ.settings = { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(state.settings || {}) };
    if (!WQ.panel) return;
    applyAccent(WQ.panel);
    repairBadStoredTitles(state);
    const currentVideoId = getCurrentVideoId();
    const currentIndex = state.queue.findIndex((item) => item.videoId === currentVideoId);
    const previousQueueItem = WatchQueueManager.getPreviousQueueVideo(state, currentVideoId);
    const nextQueueItem = WatchQueueManager.getNextQueueVideo(state, currentVideoId);
    const currentQueueText = currentIndex >= 0 ? `${currentIndex + 1} of ${state.queue.length}` : state.queue.length ? "Not in queue" : "Queue empty";

    const queueRows = state.queue.map((item, index) => {
      const progress = item.durationSeconds ? `${formatTime(item.lastWatchedSeconds)} / ${formatTime(item.durationSeconds)}` : item.lastWatchedSeconds ? `Saved ${formatTime(item.lastWatchedSeconds)}` : "Not started";
      const percentage = item.durationSeconds ? Math.min(100, Math.round((item.lastWatchedSeconds / item.durationSeconds) * 100)) : 0;
      const displayTitle = isBadVideoTitle(item.title) ? `Video ${index + 1} · ${item.videoId}` : item.title;
      const channel = item.channelName || "YouTube";
      const searchKey = `${displayTitle} ${channel}`.toLowerCase();
      return `<li class="watchqueue-row ${item.videoId === currentVideoId ? "watchqueue-row-current" : ""} ${item.completed ? "watchqueue-row-done" : ""}" draggable="true" data-index="${index}" data-video-id="${item.videoId}" data-search="${escapeHtml(searchKey)}">
          <span class="watchqueue-drag" title="Drag to reorder">⋮⋮</span>
          <div class="watchqueue-thumb-wrap"><img class="watchqueue-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" />${item.durationText ? `<span class="watchqueue-thumb-time">${escapeHtml(item.durationText)}</span>` : ""}<span class="watchqueue-progress-bar"><span style="width:${percentage}%"></span></span></div>
          <div class="watchqueue-row-main"><button class="watchqueue-title" type="button" data-action="resume" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</button><div class="watchqueue-meta"><span class="watchqueue-meta-channel">${escapeHtml(channel)}</span><span class="watchqueue-meta-progress">${progress}${item.completed ? " · Done" : ""}</span>${item.publishedText ? `<span class="watchqueue-meta-date">${escapeHtml(item.publishedText)}</span>` : ""}</div></div>
          <button class="watchqueue-icon-button" type="button" title="Remove" data-action="remove">×</button>
        </li>`;
    }).join("");

    const emptyQueueMarkup = `<li class="watchqueue-empty"><strong>Build your flow.</strong><span>Hover any YouTube thumbnail and click + Queue.</span></li>`;
    const noMatchMarkup = `<li class="watchqueue-empty watchqueue-no-match" hidden><strong>No matches.</strong><span>Nothing in the queue matches your search.</span></li>`;

    const playlists = state.playlists || [];
    const selectedPlaylist = playlists.find((playlist) => playlist.id === WQ.selectedPlaylistId);
    if (WQ.selectedPlaylistId && !selectedPlaylist) WQ.selectedPlaylistId = null;

    const playlistThumbStack = (playlist) => {
      const videos = (playlist.videos || []).slice(0, 3);
      if (!videos.length) {
        return `<span class="watchqueue-plstack watchqueue-plstack-empty" aria-hidden="true">▶</span>`;
      }
      const layers = videos.map((video, i) =>
        `<img class="watchqueue-plstack-img" style="--i:${i}" src="${escapeHtml(video.thumbnailUrl || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`)}" alt="" loading="lazy" />`
      ).join("");
      return `<span class="watchqueue-plstack" data-count="${videos.length}" aria-hidden="true">${layers}</span>`;
    };

    const playlistRows = playlists.map((playlist) => `<li class="watchqueue-playlist-row" data-playlist-id="${playlist.id}">
      <button class="watchqueue-playlist-open" type="button" data-action="playlist-open" title="${escapeHtml(playlist.name)}">
        ${playlistThumbStack(playlist)}
        <span class="watchqueue-playlist-open-text"><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.videos?.length || 0} videos</span></span>
      </button>
      <button type="button" data-action="playlist-add">Queue</button>
      <button type="button" data-action="playlist-delete">×</button>
    </li>`).join("");

    const selectedPlaylistRows = selectedPlaylist ? (selectedPlaylist.videos || []).map((item, index) => {
      const progressEntry = state.progress?.[item.videoId] || item || {};
      const watched = Number(progressEntry.lastWatchedSeconds || 0);
      const duration = Number(progressEntry.durationSeconds || 0);
      const progressText = duration > 0
        ? `${formatTime(watched)} / ${formatTime(duration)}`
        : watched > 0
          ? `Saved ${formatTime(watched)}`
          : (item.durationText || "Not started");
      const displayTitle = isBadVideoTitle(item.title) ? `Video ${index + 1} · ${item.videoId}` : item.title;
      const channel = item.channelName || "YouTube";
      const isQueued = state.queue.some((queueItem) => queueItem.videoId === item.videoId);
      return `<li class="watchqueue-row watchqueue-playlist-video-row" data-video-id="${item.videoId}">
        <span class="watchqueue-row-number">${index + 1}</span>
        <div class="watchqueue-thumb-wrap"><img class="watchqueue-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" /></div>
        <div class="watchqueue-row-main"><button class="watchqueue-title" type="button" data-action="playlist-video-play" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</button><div class="watchqueue-meta"><span class="watchqueue-meta-channel">${escapeHtml(channel)}</span><span class="watchqueue-meta-progress">${escapeHtml(progressText)}${progressEntry.completed ? " · Done" : ""}</span>${item.publishedText ? `<span class="watchqueue-meta-date">${escapeHtml(item.publishedText)}</span>` : ""}</div></div>
        <button class="watchqueue-playlist-queue-button watchqueue-plus-button ${isQueued ? "is-queued" : ""}" type="button" title="${isQueued ? "Already in queue" : "Add video to queue"}" data-action="playlist-video-queue" ${isQueued ? "disabled" : ""}>${isQueued ? "✓" : "+"}</button>
      </li>`;
    }).join("") : "";

    const playlistPage = selectedPlaylist ? `
      <div class="watchqueue-playlist-detail">
        <div class="watchqueue-detail-header"><button type="button" data-action="playlist-back">← Back</button><div><strong title="${escapeHtml(selectedPlaylist.name)}">${escapeHtml(selectedPlaylist.name)}</strong><span>${selectedPlaylist.videos?.length || 0} videos</span></div><button type="button" data-action="playlist-rename">Rename</button></div>
        <div class="watchqueue-actions watchqueue-detail-actions"><button type="button" data-action="playlist-play-first" ${(selectedPlaylist.videos || []).length ? "" : "disabled"}>Play first</button><button type="button" data-action="playlist-add-all" ${(selectedPlaylist.videos || []).length ? "" : "disabled"}>Add all to queue</button><button type="button" data-action="playlist-delete-selected">Delete</button></div>
        <ul class="watchqueue-list watchqueue-playlist-video-list">${selectedPlaylistRows || `<li class="watchqueue-empty"><strong>No videos found.</strong><span>Try importing the playlist from its YouTube playlist page.</span></li>`}</ul>
      </div>` : `
      <div class="watchqueue-scroll watchqueue-playlist-scroll">
        <div class="watchqueue-playlist-tools"><button type="button" data-action="import-current-playlist" ${!canImportCurrentYouTubePage(window.location.href) ? "disabled" : ""}>Import current YouTube playlist/show</button></div>
        <ul class="watchqueue-playlist-list">${playlistRows || `<li class="watchqueue-empty"><strong>No custom playlists yet.</strong><span>Save your queue or import a YouTube playlist.</span></li>`}</ul>
      </div>`;

    const totalDuration = totalQueueDurationText(state.queue);
    const subtitle = state.queue.length
      ? `${state.queue.length} video${state.queue.length === 1 ? "" : "s"}${totalDuration ? ` · ${totalDuration}` : ""}`
      : "No videos yet";

    WQ.panel.innerHTML = `
      <div class="watchqueue-panel-header">
        <div class="watchqueue-brand"><span class="watchqueue-logo"><span>▶</span></span><div><h3>WatchQueue</h3><p>${subtitle}</p></div></div>
        <div class="watchqueue-header-buttons"><button class="watchqueue-close" type="button" aria-label="Close WatchQueue">×</button></div>
      </div>
      <div class="watchqueue-tabs">
        <button class="${WQ.activeTab === "queue" ? "active" : ""}" data-tab="queue">Queue</button>
        <button class="${WQ.activeTab === "playlists" ? "active" : ""}" data-tab="playlists">Lists</button>
        <button class="${WQ.activeTab === "settings" ? "active" : ""}" data-tab="settings">Settings</button>
      </div>

      <div class="watchqueue-tab-page ${WQ.activeTab !== "queue" ? "watchqueue-hidden" : ""}">
        <div class="watchqueue-control-row">
          <label class="watchqueue-switch"><input type="checkbox" ${state.queueMode ? "checked" : ""} data-action="queue-mode" /><span class="watchqueue-slider"></span><span class="watchqueue-switch-label">Queue Mode</span></label>
          <div class="watchqueue-mini-nav" title="Move through your queue"><button type="button" data-action="play-prev" ${!previousQueueItem || state.queue.length < 2 ? "disabled" : ""}>Prev</button><span>${currentQueueText}</span><button type="button" data-action="play-next" ${!nextQueueItem || state.queue.length < 2 ? "disabled" : ""}>Next</button></div>
        </div>
        <div class="watchqueue-search-row ${state.queue.length ? "" : "watchqueue-hidden"}">
          <div class="watchqueue-search"><span class="watchqueue-search-icon">⌕</span><input type="text" placeholder="Search queue" value="${escapeHtml(WQ.queueSearch)}" data-action="search" /></div>
          <button type="button" class="watchqueue-tool-button watchqueue-tool-icon" data-action="reverse" title="Reverse queue order" ${state.queue.length < 2 ? "disabled" : ""}>⇅</button>
          <div class="watchqueue-sort-wrap">
            <button type="button" class="watchqueue-tool-button" data-action="sort-toggle" title="Sort queue" ${state.queue.length < 2 ? "disabled" : ""}>↕ Sort</button>
            <div class="watchqueue-sort-menu" data-sort-menu hidden>
              <button type="button" data-sort="title">Name (A–Z)</button>
              <button type="button" data-sort="date">Upload date</button>
              <button type="button" data-sort="time">Duration</button>
            </div>
          </div>
          <button type="button" class="watchqueue-shuffle" data-action="shuffle" title="Shuffle queue" ${state.queue.length < 2 ? "disabled" : ""}>⤭</button>
        </div>
        <ul class="watchqueue-list">${queueRows ? queueRows + noMatchMarkup : emptyQueueMarkup}</ul>
        <div class="watchqueue-actions"><button type="button" data-action="play-first" ${!state.queue.length ? "disabled" : ""}>Play first</button><button type="button" data-action="save-queue" ${!state.queue.length ? "disabled" : ""}>Save as playlist</button><button type="button" data-action="clear" ${!state.queue.length ? "disabled" : ""}>Clear</button></div>
      </div>

      <div class="watchqueue-tab-page ${WQ.activeTab !== "playlists" ? "watchqueue-hidden" : ""}">${playlistPage}</div>

      <div class="watchqueue-tab-page ${WQ.activeTab !== "settings" ? "watchqueue-hidden" : ""}">${WQ.activeTab === "settings" ? buildSettingsPage(state) : ""}</div>`;

    WQ.panel.querySelector(".watchqueue-close")?.addEventListener("click", () => { WQ.userOpenedPanel = false; WQ.panel.hidden = true; });
    WQ.panel.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", async () => { WQ.activeTab = button.dataset.tab; if (WQ.activeTab !== "playlists") WQ.selectedPlaylistId = null; await renderPanel(); }));

    if (WQ.activeTab === "settings") {
      bindSettingsHandlers(state);
      return;
    }

    WQ.panel.querySelector("[data-action='queue-mode']")?.addEventListener("change", async () => { await WatchQueueManager.toggleQueueMode(); await renderPanel(); });
    WQ.panel.querySelector("[data-action='play-first']")?.addEventListener("click", () => state.queue[0] && navigateToVideo(state.queue[0]));
    WQ.panel.querySelector("[data-action='play-prev']")?.addEventListener("click", () => previousQueueItem && navigateToVideo(previousQueueItem));
    WQ.panel.querySelector("[data-action='play-next']")?.addEventListener("click", () => nextQueueItem && navigateToVideo(nextQueueItem));
    WQ.panel.querySelector("[data-action='shuffle']")?.addEventListener("click", async () => { await WatchQueueManager.shuffleQueue(); await renderWidget(); await renderPanel(); showToast("Queue shuffled"); });
    WQ.panel.querySelector("[data-action='reverse']")?.addEventListener("click", async () => { await WatchQueueManager.reverseQueue(); await renderWidget(); await renderPanel(); showToast("Queue reversed"); });
    const sortToggle = WQ.panel.querySelector("[data-action='sort-toggle']");
    const sortMenu = WQ.panel.querySelector("[data-sort-menu]");
    if (sortToggle && sortMenu) {
      sortToggle.addEventListener("click", (event) => { event.stopPropagation(); sortMenu.hidden = !sortMenu.hidden; });
      sortMenu.querySelectorAll("[data-sort]").forEach((button) => {
        button.addEventListener("click", async () => {
          sortMenu.hidden = true;
          await WatchQueueManager.sortQueue(button.dataset.sort);
          await renderWidget();
          await renderPanel();
          const labels = { title: "name", date: "upload date", time: "duration" };
          showToast(`Sorted by ${labels[button.dataset.sort] || "name"}`);
        });
      });
      // close the menu when clicking elsewhere in the panel
      WQ.panel.addEventListener("click", (event) => {
        if (!sortMenu.hidden && !event.target.closest(".watchqueue-sort-wrap")) sortMenu.hidden = true;
      });
    }

    const searchInput = WQ.panel.querySelector("[data-action='search']");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        WQ.queueSearch = searchInput.value;
        applyQueueFilter();
      });
    }
    // apply any existing search filter to the freshly-rendered rows
    applyQueueFilter();

    WQ.panel.querySelector("[data-action='clear']")?.addEventListener("click", async () => {
      if (WQ.settings.confirmClear !== false) {
        const ok = await showConfirmDialog({ title: "Clear queue", message: `Remove all ${state.queue.length} video${state.queue.length === 1 ? "" : "s"} from the queue? Saved progress is kept.`, confirmText: "Clear" });
        if (!ok) return;
      }
      WQ.queueSearch = "";
      await WatchQueueManager.clearQueue();
      await renderWidget();
      await renderPanel();
    });
    WQ.panel.querySelector("[data-action='save-queue']")?.addEventListener("click", async () => {
      const name = await showNameDialog({ title: "Save queue as playlist", label: "Playlist name", initialValue: "Saved WatchQueue", confirmText: "Save playlist" });
      if (name) {
        const playlist = await WatchQueueManager.addQueueToCustomPlaylist(name);
        WQ.activeTab = "playlists";
        WQ.selectedPlaylistId = playlist.id;
        await renderPanel();
      }
    });
    WQ.panel.querySelector("[data-action='import-current-playlist']")?.addEventListener("click", async () => {
      if (!canImportCurrentYouTubePage(window.location.href)) return;
      showToast(isShowPage(window.location.href) ? "Saving current show…" : "Saving current playlist…");
      try {
        const result = await importPlaylistFromUrl(window.location.href, document.title.replace(" - YouTube", "") || "Imported playlist");
        WQ.selectedPlaylistId = result.playlist.id;
        await renderWidget();
        await renderPanel();
        showToast(`Saved playlist with ${result.addedCount} videos`);
      } catch {
        showToast("Could not import this playlist yet");
      }
    });

    WQ.panel.querySelector("[data-action='playlist-back']")?.addEventListener("click", async () => { WQ.selectedPlaylistId = null; await renderPanel(); });
    WQ.panel.querySelector("[data-action='playlist-rename']")?.addEventListener("click", async () => {
      if (!selectedPlaylist) return;
      const name = await showNameDialog({ title: "Rename playlist", label: "Playlist name", initialValue: selectedPlaylist.name, confirmText: "Rename" });
      if (!name) return;
      await WatchQueueManager.renameCustomPlaylist(selectedPlaylist.id, name);
      await renderPanel();
    });
    WQ.panel.querySelector("[data-action='playlist-play-first']")?.addEventListener("click", () => selectedPlaylist?.videos?.[0] && navigateToVideo(selectedPlaylist.videos[0]));
    WQ.panel.querySelector("[data-action='playlist-add-all']")?.addEventListener("click", async () => { if (!selectedPlaylist) return; const result = await WatchQueueManager.addPlaylistToQueue(selectedPlaylist.id); await renderWidget(); await renderPanel(); showToast(`Added ${result.addedCount} videos to queue`); });
    WQ.panel.querySelector("[data-action='playlist-delete-selected']")?.addEventListener("click", async () => {
      if (!selectedPlaylist) return;
      const ok = await showConfirmDialog({ title: "Delete playlist", message: `Delete "${selectedPlaylist.name}"? This can't be undone.`, confirmText: "Delete" });
      if (!ok) return;
      await WatchQueueManager.deleteCustomPlaylist(selectedPlaylist.id);
      WQ.selectedPlaylistId = null;
      await renderPanel();
    });

    WQ.panel.querySelectorAll(".watchqueue-playlist-row").forEach((row) => {
      row.addEventListener("click", async (event) => {
        const action = event.target?.closest("[data-action]")?.dataset?.action;
        if (action === "playlist-open") { WQ.selectedPlaylistId = row.dataset.playlistId; await renderPanel(); }
        if (action === "playlist-add") { const result = await WatchQueueManager.addPlaylistToQueue(row.dataset.playlistId); await renderWidget(); await renderPanel(); showToast(`Added ${result.addedCount} videos to queue`); }
        if (action === "playlist-delete") {
          const target = playlists.find((playlist) => playlist.id === row.dataset.playlistId);
          const ok = await showConfirmDialog({ title: "Delete playlist", message: `Delete "${target?.name || "this playlist"}"? This can't be undone.`, confirmText: "Delete" });
          if (!ok) return;
          await WatchQueueManager.deleteCustomPlaylist(row.dataset.playlistId);
          await renderPanel();
        }
      });
    });

    WQ.panel.querySelectorAll(".watchqueue-playlist-video-row").forEach((row) => {
      row.addEventListener("click", async (event) => {
        const action = event.target?.closest("[data-action]")?.dataset?.action;
        const videoId = row.dataset.videoId;
        const item = selectedPlaylist?.videos?.find((entry) => entry.videoId === videoId);
        if (!item) return;
        if (action === "playlist-video-play") await navigateToVideo(item);
        if (action === "playlist-video-queue") {
          const result = await WatchQueueManager.addVideo(item);
          await renderWidget();
          await renderPanel();
          showToast(result?.wasDuplicate ? "Already in queue" : "Added to queue");
        }
      });
    });

    WQ.panel.querySelectorAll(".watchqueue-row[data-index]").forEach((row) => {
      row.addEventListener("click", async (event) => {
        const action = event.target?.closest("[data-action]")?.dataset?.action;
        const videoId = row.dataset.videoId;
        const item = state.queue.find((queueItem) => queueItem.videoId === videoId);
        if (action === "resume" && item) await navigateToVideo(item);
        if (action === "remove") { await WatchQueueManager.removeVideo(videoId); await renderWidget(); await renderPanel(); }
      });
      row.addEventListener("dragstart", (event) => {
        if ((WQ.queueSearch || "").trim()) { event.preventDefault(); return; }
        row.classList.add("watchqueue-dragging");
        event.dataTransfer.setData("text/plain", row.dataset.index);
      });
      row.addEventListener("dragend", () => row.classList.remove("watchqueue-dragging"));
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        if ((WQ.queueSearch || "").trim()) return;
        const fromIndex = Number(event.dataTransfer.getData("text/plain"));
        const toIndex = Number(row.dataset.index);
        if (Number.isInteger(fromIndex) && Number.isInteger(toIndex) && fromIndex !== toIndex) { await WatchQueueManager.reorderQueue(fromIndex, toIndex); await renderPanel(); }
      });
    });
  }

  function parseTimestampParam() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("t") || params.get("start");
    if (!raw) return 0;
    const value = String(raw).trim();
    const h = value.match(/(\d+)h/);
    const m = value.match(/(\d+)m/);
    const sec = value.match(/(\d+)s/);
    if (h || m || sec) return (Number(h?.[1] || 0) * 3600) + (Number(m?.[1] || 0) * 60) + Number(sec?.[1] || 0);
    const numeric = Number(value.replace(/s$/, ""));
    return Number.isFinite(numeric) ? numeric : 0;
  }

  async function getStoredResumeSeconds(videoId) {
    if (!videoId) return 0;
    const state = await WatchQueueStorage.getState();
    const queuedItem = state.queue.find((item) => item.videoId === videoId) || {};
    const progress = state.progress?.[videoId] || {};
    return getResumeSeconds({ ...queuedItem, lastWatchedSeconds: progress.lastWatchedSeconds ?? queuedItem.lastWatchedSeconds ?? 0, completed: progress.completed ?? queuedItem.completed ?? false });
  }

  async function applyResumeTimestampIfNeeded(video, videoId, force = false) {
    if (!video || !videoId) return;
    const targetSeconds = Math.floor(parseTimestampParam() || await getStoredResumeSeconds(videoId) || 0);
    if (targetSeconds <= 0) return;
    if (!force && WQ.resumeAppliedForVideoId === videoId) return;
    const apply = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      if (targetSeconds >= video.duration - 8) return;
      if (Math.abs(video.currentTime - targetSeconds) > 2) video.currentTime = targetSeconds;
      WQ.resumeAppliedForVideoId = videoId;
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener("loadedmetadata", apply, { once: true });
  }

  function cancelAutoNextTimer() {
    if (WQ.autoNextTimer) {
      clearTimeout(WQ.autoNextTimer);
      WQ.autoNextTimer = null;
    }
  }

  async function scheduleAutoNext(reason = "ended") {
    const currentId = getCurrentVideoId();
    if (!currentId || WQ.autoNextHandledForVideoId === currentId || WQ.autoNextTimer) return;
    const state = await WatchQueueStorage.getState();
    if (!state.queueMode) return;
    if (reason === "near-end" && state.settings?.autoNextNearEnd === false) return;
    const next = WatchQueueManager.getNextVideo(state, currentId);
    if (!next) return;
    WQ.autoNextHandledForVideoId = currentId;
    const delayMs = Math.max(0, num(state.settings?.autoNextDelaySeconds, 10) * 1000);
    const delaySeconds = Math.round(delayMs / 1000);
    if (delaySeconds > 0) showToast(`Next queued video in ${delaySeconds} second${delaySeconds === 1 ? "" : "s"}…`);
    WQ.autoNextTimer = setTimeout(async () => {
      WQ.autoNextTimer = null;
      if (getCurrentVideoId() !== currentId) return;
      await WatchQueueManager.markCompleted(currentId);
      const latestState = await WatchQueueStorage.getState();
      if (!latestState.queueMode) return;
      const latestNext = WatchQueueManager.getNextVideo(latestState, currentId);
      if (latestState.settings?.autoRemoveWatched) await WatchQueueManager.removeVideo(currentId);
      if (latestNext) {
        showToast(reason === "near-end" ? "Moving to next queued video…" : "Playing next queued video…");
        await navigateToVideo(latestNext);
      } else {
        await renderWidget();
        if (WQ.panel && !WQ.panel.hidden) await renderPanel();
      }
    }, delayMs);
  }

  function attachPlayerWatcher() {
    const video = document.querySelector("video");
    if (!video) return;
    const currentId = getCurrentVideoId();
    if (currentId && currentId !== WQ.lastKnownVideoId) {
      WQ.lastKnownVideoId = currentId;
      WQ.resumeAppliedForVideoId = null;
      WQ.autoNextHandledForVideoId = null;
      cancelAutoNextTimer();
      applyResumeTimestampIfNeeded(video, currentId, true);
    }
    if (WQ.videoListenerAttachedTo === video) return;
    WQ.videoListenerAttachedTo = video;

    video.addEventListener("timeupdate", async () => {
      const videoId = getCurrentVideoId();
      if (!videoId) return;
      const now = Date.now();
      if (now - WQ.lastSavedAt >= PROGRESS_SAVE_INTERVAL_MS) {
        WQ.lastSavedAt = now;
        await WatchQueueManager.saveProgress(videoId, video.currentTime, video.duration);
      }
      const nearEnd = Math.max(3, num(WQ.settings.nearEndSeconds, 10));
      if (Number.isFinite(video.duration) && video.duration > 20 && video.duration - video.currentTime <= nearEnd) {
        await scheduleAutoNext("near-end");
      } else if (WQ.autoNextTimer && Number.isFinite(video.duration) && video.duration - video.currentTime > nearEnd + 5) {
        cancelAutoNextTimer();
        WQ.autoNextHandledForVideoId = null;
      }
    });
    video.addEventListener("loadedmetadata", () => { const videoId = getCurrentVideoId(); if (videoId) applyResumeTimestampIfNeeded(video, videoId); });
    video.addEventListener("ended", () => scheduleAutoNext("ended"));
  }

  function updateFullscreenVisibility() {
    const player = document.querySelector("#movie_player");
    const isFullscreen = Boolean(document.fullscreenElement || player?.classList.contains("ytp-fullscreen") || document.querySelector(".ytp-fullscreen"));
    document.documentElement.classList.toggle("watchqueue-is-fullscreen", isFullscreen);
    if (WQ.widget) WQ.widget.style.display = isFullscreen ? "none" : "";
    if (WQ.panel && isFullscreen) { WQ.panel.hidden = true; WQ.userOpenedPanel = false; }
  }

  function closePanelFromOutside(event) {
    if (!WQ.panel || WQ.panel.hidden) return;
    if (WQ.widget?.contains(event.target)) return;
    if (event.target?.closest?.(".watchqueue-name-dialog")) return;
    WQ.userOpenedPanel = false;
    WQ.panel.hidden = true;
  }

  function observeYouTube() {
    if (WQ.observer) return;
    let scheduled = false;
    WQ.observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(async () => {
        scheduled = false;
        await injectThumbnailButtons();
        attachPlayerWatcher();
        updateFullscreenVisibility();
        // keep auto theme in sync with YouTube's dark/light toggle
        if ((WQ.settings.theme || "auto") === "auto" && WQ.widget) {
          const desired = getThemeClass();
          if (!WQ.widget.classList.contains(desired)) applyWidgetChrome();
        }
      }, 600);
    });
    WQ.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "fullscreen", "dark"] });
  }

  async function init() {
    await loadSettings();
    await renderWidget();
    await injectThumbnailButtons();
    attachPlayerWatcher();
    observeYouTube();
    updateFullscreenVisibility();
    window.addEventListener("yt-navigate-finish", async () => { await injectThumbnailButtons(); attachPlayerWatcher(); await renderWidget(); updateFullscreenVisibility(); });
    document.addEventListener("fullscreenchange", updateFullscreenVisibility);
    document.addEventListener("pointerdown", closePanelFromOutside, true);
    window.addEventListener("resize", async () => { const state = await WatchQueueStorage.getState(); positionWidget(state.widgetPosition || getDefaultWidgetPosition()); });
    window.addEventListener("watchqueue:state-changed", async () => {
      if (!WQ.panel || WQ.panel.hidden || WQ.activeTab === "settings") return;
      const active = WQ.panel.querySelector("[data-action='search']");
      if (active && document.activeElement === active) return; // don't yank focus mid-search
      await renderPanel();
    });
    chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
      if (message?.type !== "WATCHQUEUE_TOGGLE_WIDGET") return;
      (async () => {
        const state = await WatchQueueStorage.getState();
        if (state.widgetHidden || !WQ.widget) {
          await WatchQueueManager.setWidgetHidden(false);
          await renderWidget();
          sendResponse({ visible: true });
          return;
        }
        await WatchQueueManager.setWidgetHidden(true);
        await renderWidget();
        sendResponse({ visible: false });
      })();
      return true;
    });
  }

  init().catch((error) => {
    const message = String(error?.message || error || "");
    if (message.includes("Extension context invalidated") || message.includes("context invalidated")) {
      console.warn("WatchQueue: extension was reloaded. Refresh this YouTube tab to reconnect WatchQueue.");
      return;
    }
    console.warn("WatchQueue init failed", error);
  });
})();
