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
    sleepTimerEnd: null,
    sleepTimerInterval: null,
    sleepPopoverOpen: false,
    selectedPlaylistId: null,
    metadataRepairInFlight: false,
    queueSearch: "",
    playlistSearch: "",
    playlistVideoSearch: "",
    historySearch: "",
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

  async function showQueuePickerDialog({ title = "Add to queue", confirmText = "Add" } = {}) {
    const state = await WatchQueueStorage.getState();
    const queues = state.savedQueues || [];
    if (queues.length < 2) return state.activeQueueId || null;
    return new Promise((resolve) => {
      const existing = document.querySelector(".watchqueue-name-dialog");
      if (existing) existing.remove();
      const overlay = document.createElement("div");
      overlay.className = `watchqueue-name-dialog ${getThemeClass()}`;
      applyAccent(overlay);
      const radioRows = queues.map((sq) => {
        const count = sq.id === state.activeQueueId ? state.queue.length : (sq.queue || []).length;
        const isActive = sq.id === state.activeQueueId;
        return `<label class="watchqueue-queue-picker-option ${isActive ? "is-active" : ""}">
          <input type="radio" name="wq-picker-queue" value="${sq.id}" ${isActive ? "checked" : ""} />
          <span class="watchqueue-queue-picker-name">${escapeHtml(sq.name)}</span>
          <span class="watchqueue-queue-picker-count">${count}${isActive ? " · active" : ""}</span>
        </label>`;
      }).join("");
      overlay.innerHTML = `
        <div class="watchqueue-name-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="watchqueue-name-header">
            <strong>${escapeHtml(title)}</strong>
            <button type="button" data-action="cancel" aria-label="Close">×</button>
          </div>
          <div class="watchqueue-queue-picker-list">${radioRows}</div>
          <div class="watchqueue-name-actions">
            <button type="button" data-action="cancel">Cancel</button>
            <button type="button" data-action="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = (value) => { overlay.remove(); resolve(value); };
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) cleanup(null); });
      overlay.querySelectorAll("[data-action='cancel']").forEach((button) => button.addEventListener("click", () => cleanup(null)));
      overlay.querySelector("[data-action='confirm']")?.addEventListener("click", () => {
        const selected = overlay.querySelector("input[name='wq-picker-queue']:checked");
        cleanup(selected ? selected.value : null);
      });
      document.addEventListener("keydown", function onKey(event) {
        if (event.key === "Escape") { document.removeEventListener("keydown", onKey); cleanup(null); }
      });
    });
  }

  // Helper: picks a target queue (shows dialog if multiple exist), then adds videos.
  // Returns null if user cancelled, otherwise { addedCount, duplicateCount, queueName }.
  async function pickQueueAndAddVideo(video) {
    const state = await WatchQueueStorage.getState();
    const queues = state.savedQueues || [];
    if (queues.length < 2) {
      const result = await WatchQueueManager.addVideo(video);
      return { ...result, queueName: null };
    }
    const targetId = await showQueuePickerDialog({ title: "Add to which queue?", confirmText: "Add" });
    if (!targetId) return null;
    const result = await WatchQueueManager.addVideoToSpecificQueue(targetId, video);
    const targetName = queues.find((q) => q.id === targetId)?.name || "queue";
    return { ...result, queueName: targetName };
  }

  async function pickQueueAndAddPlaylist(playlistId) {
    const state = await WatchQueueStorage.getState();
    const queues = state.savedQueues || [];
    if (queues.length < 2) {
      const result = await WatchQueueManager.addPlaylistToQueue(playlistId);
      return { ...result, queueName: null };
    }
    const targetId = await showQueuePickerDialog({ title: "Add playlist to which queue?", confirmText: "Add all" });
    if (!targetId) return null;
    const result = await WatchQueueManager.addPlaylistToSpecificQueue(playlistId, targetId);
    const targetName = queues.find((q) => q.id === targetId)?.name || "queue";
    return { ...result, queueName: targetName };
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
      // Skip if this card already has a "+ List" button (it's a playlist card, not a single video)
      if (card.querySelector(".watchqueue-list-add-button")) continue;
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

  function restoreScrollPositions(container, positions) {
    if (!container || !positions || !Object.keys(positions).length) return;
    // Immediate attempt
    for (const [sel, top] of Object.entries(positions)) {
      const el = container.querySelector(sel);
      if (el) el.scrollTop = top;
    }
    // Retry after layout in case the DOM isn't fully measured yet
    requestAnimationFrame(() => {
      for (const [sel, top] of Object.entries(positions)) {
        const el = container.querySelector(sel);
        if (el && Math.abs(el.scrollTop - top) > 2) el.scrollTop = top;
      }
    });
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
          ${toggleControl("autoNextEnabled", "Auto-play next video", s.autoNextEnabled !== false, "Automatically play the next queued video when one finishes or nears the end.")}
          <div class="watchqueue-autonext-details ${s.autoNextEnabled === false ? "watchqueue-hidden" : ""}">
            ${sliderControl("autoNextDelaySeconds", "Countdown delay", 0, 30, num(s.autoNextDelaySeconds, 10))}
            ${sliderControl("nearEndSeconds", "Near-end trigger window", 3, 30, num(s.nearEndSeconds, 10), "s before end")}
          </div>
          ${toggleControl("loopQueue", "Loop queue", Boolean(s.loopQueue), "Wrap back to the top when the queue ends.")}
          ${toggleControl("autoRemoveWatched", "Auto-remove watched", Boolean(s.autoRemoveWatched), "Drop videos from the queue once they finish.")}
        </div>

        <div class="watchqueue-settings-group">
          <h4>Interface</h4>
          ${toggleControl("showThumbnailButtons", "Show + Queue on thumbnails", s.showThumbnailButtons !== false, "Hover buttons on YouTube thumbnails.")}
          ${toggleControl("confirmClear", "Confirm before clearing", s.confirmClear !== false, "Ask before emptying the whole queue.")}
        </div>

        <div class="watchqueue-settings-group">
          <h4>Sleep timer</h4>
          <span class="watchqueue-setting-desc">Set a sleep timer from the clock icon beside Queue Mode. When the timer ends the video pauses automatically.</span>
          ${toggleControl("sleepCloseTab", "Close tab when timer ends", Boolean(s.sleepCloseTab), "Close the browser tab instead of just pausing.")}
        </div>

        <div class="watchqueue-settings-group">
          <h4>Storage &amp; history</h4>
          ${toggleControl("keepTimestamps", "Save watch progress", s.keepTimestamps !== false, "Track playback position for each video.")}
          <div class="watchqueue-timestamps-details ${s.keepTimestamps === false ? "watchqueue-hidden" : ""}">
            ${sliderControl("progressRetentionDays", "Keep timestamps for", 7, 365, num(s.progressRetentionDays, 90), " days")}
          </div>
          <div class="watchqueue-setting watchqueue-setting-info">
            <span class="watchqueue-setting-desc">Saved timestamps: <strong data-progress-count>…</strong> videos tracked</span>
          </div>
          <div class="watchqueue-settings-buttons">
            <button type="button" data-action="prune-progress">Prune old timestamps</button>
            <button type="button" data-action="clear-progress" class="watchqueue-danger-outline">Clear all timestamps</button>
          </div>
          <div class="watchqueue-setting" style="margin-top:8px">
            <div class="watchqueue-setting-top"><label>Clear watch history</label></div>
            <div class="watchqueue-settings-buttons">
              <button type="button" data-action="clear-history-hour">Last hour</button>
              <button type="button" data-action="clear-history-day">Last day</button>
              <button type="button" data-action="clear-history-week">Last week</button>
              <button type="button" data-action="clear-history-month">Last month</button>
            </div>
          </div>
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

  function formatRelativeTime(timestamp) {
    if (!timestamp) return "";
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  function buildHistoryPage(state) {
    const entries = Object.entries(state.progress || {})
      .filter(([, entry]) => entry.lastWatchedSeconds > 0 || entry.completed)
      .map(([videoId, entry]) => {
        const queueItem = state.queue.find((v) => v.videoId === videoId);
        const playlistItem = !queueItem ? (state.playlists || []).flatMap((pl) => pl.videos || []).find((v) => v.videoId === videoId) : null;
        const savedQueueItem = !queueItem && !playlistItem ? (state.savedQueues || []).flatMap((sq) => sq.queue || []).find((v) => v.videoId === videoId) : null;
        const meta = queueItem || playlistItem || savedQueueItem || {};
        return {
          videoId,
          title: meta.title || `YouTube video ${videoId}`,
          channelName: meta.channelName || "YouTube",
          thumbnailUrl: meta.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          durationText: meta.durationText || "",
          lastWatchedSeconds: entry.lastWatchedSeconds || 0,
          durationSeconds: entry.durationSeconds || 0,
          completed: Boolean(entry.completed),
          updatedAt: entry.updatedAt || 0
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const historyRows = entries.map((item) => {
      const progress = item.durationSeconds ? `${formatTime(item.lastWatchedSeconds)} / ${formatTime(item.durationSeconds)}` : item.lastWatchedSeconds ? `Saved ${formatTime(item.lastWatchedSeconds)}` : "Not started";
      const percentage = item.durationSeconds ? Math.min(100, Math.round((item.lastWatchedSeconds / item.durationSeconds) * 100)) : 0;
      const displayTitle = isBadVideoTitle(item.title) ? `Video · ${item.videoId}` : item.title;
      const searchKey = `${displayTitle} ${item.channelName}`.toLowerCase();
      return `<li class="watchqueue-row ${item.completed ? "watchqueue-row-done" : ""}" data-video-id="${item.videoId}" data-search="${escapeHtml(searchKey)}">
        <span class="watchqueue-row-number" style="font-size:10px;color:var(--wq-muted)">${formatRelativeTime(item.updatedAt)}</span>
        <div class="watchqueue-thumb-wrap"><img class="watchqueue-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" />${item.durationText ? `<span class="watchqueue-thumb-time">${escapeHtml(item.durationText)}</span>` : ""}<span class="watchqueue-progress-bar"><span style="width:${percentage}%"></span></span>${item.completed ? `<span class="watchqueue-done-badge" title="Watched">✓</span>` : ""}</div>
        <div class="watchqueue-row-main"><button class="watchqueue-title" type="button" data-action="history-play" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</button><div class="watchqueue-meta"><span class="watchqueue-meta-channel">${escapeHtml(item.channelName)}</span><span class="watchqueue-meta-progress">${progress}${item.completed ? " · Done" : ""}</span></div></div>
        <div class="watchqueue-row-actions"><button class="watchqueue-icon-button watchqueue-reset-button" type="button" title="Reset timestamp" data-action="history-reset">${toolbarIcon("reset")}</button></div>
      </li>`;
    }).join("");

    const noMatchMarkup = `<li class="watchqueue-empty watchqueue-no-match" hidden><strong>No matches.</strong></li>`;

    return `
      <div class="watchqueue-scroll watchqueue-history-scroll">
        ${entries.length > 3 ? `<div class="watchqueue-search-row"><div class="watchqueue-search"><span class="watchqueue-search-icon">⌕</span><input type="text" placeholder="Search history" value="${escapeHtml(WQ.historySearch)}" data-action="history-search" /></div></div>` : ""}
        <ul class="watchqueue-list watchqueue-history-list" style="grid-template-columns:unset">${historyRows ? historyRows + noMatchMarkup : `<li class="watchqueue-empty"><strong>No watch history yet.</strong><span>Videos you watch will appear here.</span></li>`}</ul>
        ${entries.length ? `<div class="watchqueue-actions"><button type="button" data-action="history-clear-all" class="watchqueue-danger-outline">Clear all history</button></div>` : ""}
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
        // Show/hide conditional sub-sections
        if (key === "autoNextEnabled") {
          const details = WQ.panel.querySelector(".watchqueue-autonext-details");
          if (details) details.classList.toggle("watchqueue-hidden", !toggle.checked);
        }
        if (key === "keepTimestamps") {
          const details = WQ.panel.querySelector(".watchqueue-timestamps-details");
          if (details) details.classList.toggle("watchqueue-hidden", !toggle.checked);
        }
        // When auto-remove is turned ON, sweep existing completed videos
        if (key === "autoRemoveWatched" && toggle.checked) {
          await WatchQueueManager.removeCompletedFromQueue();
          await renderWidget();
        }
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
    // storage management
    WatchQueueManager.getProgressCount().then((count) => {
      const el = WQ.panel?.querySelector("[data-progress-count]");
      if (el) el.textContent = String(count);
    });
    WQ.panel.querySelector("[data-action='prune-progress']")?.addEventListener("click", async () => {
      const beforeCount = await WatchQueueManager.getProgressCount();
      await WatchQueueManager.pruneProgress();
      const afterCount = await WatchQueueManager.getProgressCount();
      const el = WQ.panel?.querySelector("[data-progress-count]");
      if (el) el.textContent = String(afterCount);
      showToast(`Pruned ${beforeCount - afterCount} old entries`);
    });
    WQ.panel.querySelector("[data-action='clear-progress']")?.addEventListener("click", async () => {
      const ok = await showConfirmDialog({ title: "Clear all timestamps", message: "Remove all saved video timestamps? Queue and playlists are kept but progress will show 'Not started'.", confirmText: "Clear", danger: true });
      if (!ok) return;
      await WatchQueueManager.clearAllProgress();
      const el = WQ.panel?.querySelector("[data-progress-count]");
      if (el) el.textContent = "0";
      showToast("All timestamps cleared");
    });
    // clear watch history by age
    for (const period of ["hour", "day", "week", "month"]) {
      WQ.panel.querySelector(`[data-action='clear-history-${period}']`)?.addEventListener("click", async () => {
        const labels = { hour: "last hour", day: "last 24 hours", week: "last 7 days", month: "last 30 days" };
        const ok = await showConfirmDialog({ title: "Clear watch history", message: `Remove all watch history from the ${labels[period]}?`, confirmText: "Clear" });
        if (!ok) return;
        await WatchQueueManager.clearProgressByAge(period);
        const afterCount = await WatchQueueManager.getProgressCount();
        const el = WQ.panel?.querySelector("[data-progress-count]");
        if (el) el.textContent = String(afterCount);
        showToast(`Cleared history from ${labels[period]}`);
      });
    }
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

  function applyPlaylistFilter() {
    if (!WQ.panel) return;
    const list = WQ.panel.querySelector(".watchqueue-playlist-list");
    if (!list) return;
    const term = (WQ.playlistSearch || "").trim().toLowerCase();
    const rows = Array.from(list.querySelectorAll(".watchqueue-playlist-row"));
    let visibleCount = 0;
    rows.forEach((row) => {
      const key = row.dataset.search || "";
      const match = !term || key.includes(term);
      row.hidden = !match;
      if (match) visibleCount += 1;
    });
    const noMatch = list.querySelector(".watchqueue-no-match");
    if (noMatch) noMatch.hidden = !(term && rows.length && visibleCount === 0);
  }

  function applyPlaylistVideoFilter() {
    if (!WQ.panel) return;
    const list = WQ.panel.querySelector(".watchqueue-playlist-video-list");
    if (!list) return;
    const term = (WQ.playlistVideoSearch || "").trim().toLowerCase();
    const rows = Array.from(list.querySelectorAll(".watchqueue-playlist-video-row"));
    let visibleCount = 0;
    rows.forEach((row) => {
      const key = row.dataset.search || "";
      const match = !term || key.includes(term);
      row.hidden = !match;
      if (match) visibleCount += 1;
    });
    const noMatch = list.querySelector(".watchqueue-no-match");
    if (noMatch) noMatch.hidden = !(term && rows.length && visibleCount === 0);
  }

  function applyHistoryFilter() {
    if (!WQ.panel) return;
    const list = WQ.panel.querySelector(".watchqueue-history-list");
    if (!list) return;
    const term = (WQ.historySearch || "").trim().toLowerCase();
    const rows = Array.from(list.querySelectorAll(".watchqueue-row"));
    let visibleCount = 0;
    rows.forEach((row) => {
      const key = row.dataset.search || "";
      const match = !term || key.includes(term);
      row.hidden = !match;
      if (match) visibleCount += 1;
    });
    const noMatch = list.querySelector(".watchqueue-no-match");
    if (noMatch) noMatch.hidden = !(term && rows.length && visibleCount === 0);
  }

  function toolbarIcon(name, enabled = false) {
    const common = 'class="watchqueue-svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
    const slash = '<line x1="3" y1="21" x2="21" y2="3" class="watchqueue-icon-slash" />';

    if (name === "reverse") {
      // Clean vertical swap arrows — up on left, down on right
      return `<svg ${common}>
        <path d="M7 18V6" />
        <path d="M3.5 10L7 6l3.5 4" />
        <path d="M17 6v12" />
        <path d="M13.5 14l3.5 4 3.5-4" />
      </svg>`;
    }

    if (name === "loop") {
      // Standard repeat/loop icon — two curved arrows forming a cycle
      return `<svg ${common}>
        <path d="M17 2l3 3.5-3 3.5" />
        <path d="M3.5 11.5a8 8 0 018-8h8.5" />
        <path d="M7 22l-3-3.5 3-3.5" />
        <path d="M20.5 12.5a8 8 0 01-8 8H4" />
        ${enabled ? "" : slash}
      </svg>`;
    }

    if (name === "autoRemove") {
      // Clean trash-can with a checkmark (on) or X (off) badge
      return `<svg ${common}>
        <path d="M8.5 6V5a1.5 1.5 0 011.5-1.5h4A1.5 1.5 0 0115.5 5v1" />
        <path d="M5 6h14" />
        <path d="M6.5 6l.8 12.5a1.5 1.5 0 001.5 1.5h6.4a1.5 1.5 0 001.5-1.5l.3-5" />
        <path d="M10.2 10v7" />
        <path d="M13.8 10v4" />
        ${enabled
          ? '<path d="M16 15l2 2 4-4.5" class="watchqueue-icon-mark" />'
          : '<path d="M16.5 14.5l4 4M20.5 14.5l-4 4" class="watchqueue-icon-mark" />'}
      </svg>`;
    }

    if (name === "shuffle") {
      // Standard shuffle — two crossing paths with arrowheads
      return `<svg ${common}>
        <path d="M3 17h2.5a4 4 0 003.2-1.6l4.6-6.3A4 4 0 0116.5 7.5H18" />
        <path d="M18 4.5l3 3-3 3" />
        <path d="M3 7.5h2.5a4 4 0 013.2 1.6l4.6 6.3a4 4 0 003.2 1.6H18" />
        <path d="M18 14l3 3-3 3" />
        ${enabled ? "" : slash}
      </svg>`;
    }

    if (name === "reset") {
      // Counter-clockwise circular arrow (undo/reset)
      return `<svg ${common}>
        <path d="M4 12a8 8 0 018-8 8 8 0 017.4 5" />
        <path d="M7.5 3L4 6.5 7.5 10" />
        <path d="M20 12a8 8 0 01-8 8 8 8 0 01-7.4-5" />
      </svg>`;
    }

    if (name === "sleep") {
      // Alarm clock with bells
      return `<svg ${common}>
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l2.5 1.5" />
        <path d="M5.5 5L3 3" />
        <path d="M18.5 5L21 3" />
        <path d="M12 5V3" />
      </svg>`;
    }

    if (name === "queueAdd") {
      // List with a plus — add to queue
      return `<svg ${common}>
        <path d="M4 6h10" />
        <path d="M4 11h7" />
        <path d="M4 16h5" />
        <path d="M17 13v6" />
        <path d="M14 16h6" />
      </svg>`;
    }

    if (name === "edit") {
      // Pencil
      return `<svg ${common}>
        <path d="M17.5 3.5l3 3L8 19l-4 1 1-4L17.5 3.5z" />
        <path d="M14.5 6.5l3 3" />
      </svg>`;
    }

    if (name === "back") {
      // Left arrow
      return `<svg ${common}>
        <path d="M19 12H5" />
        <path d="M11 18l-6-6 6-6" />
      </svg>`;
    }

    return "";
  }

  // ---------- sleep timer ----------
  function startSleepTimer(minutes) {
    clearSleepTimer(false);
    WQ.sleepTimerEnd = Date.now() + minutes * 60 * 1000;
    saveSleepTimerToStorage();
    WQ.sleepTimerInterval = setInterval(sleepTimerTick, 1000);
    WQ.sleepPopoverOpen = false;
    const popover = WQ.panel?.querySelector(".watchqueue-sleep-popover");
    if (popover) popover.classList.add("watchqueue-hidden");
    updateSleepDisplay();
    showToast(`Sleep timer: ${minutes} minute${minutes === 1 ? "" : "s"}`);
  }

  function clearSleepTimer(notify = true) {
    if (WQ.sleepTimerInterval) { clearInterval(WQ.sleepTimerInterval); WQ.sleepTimerInterval = null; }
    WQ.sleepTimerEnd = null;
    saveSleepTimerToStorage();
    updateSleepDisplay();
    if (notify) {
      WQ.sleepPopoverOpen = false;
      if (WQ.panel && !WQ.panel.hidden) renderPanel();
    }
  }

  function sleepTimerTick() {
    if (!WQ.sleepTimerEnd) return;
    const remaining = WQ.sleepTimerEnd - Date.now();
    if (remaining <= 0) {
      clearSleepTimer(false);
      executeSleepAction();
      return;
    }
    updateSleepDisplay();
  }

  function executeSleepAction() {
    // Use YouTube's own player API to pause — this properly sets the player
    // state so autoplay, queue-next, and ad-resume all respect the pause.
    const video = document.querySelector("video");
    if (video && !video.paused) video.pause();
    const player = document.querySelector("#movie_player");
    if (player && typeof player.pauseVideo === "function") {
      player.pauseVideo();
    } else {
      const btn = document.querySelector(".ytp-play-button");
      if (btn) btn.click();
    }

    if (settings().sleepCloseTab) {
      showToast("Sleep timer ended — closing tab…");
      setTimeout(() => {
        try { chrome.runtime?.sendMessage({ type: "WATCHQUEUE_CLOSE_TAB" }); } catch {}
        setTimeout(() => { try { window.close(); } catch {} }, 500);
      }, 1200);
    } else {
      showToast("Sleep timer ended — video paused");
    }
  }

  function getSleepRemainingText() {
    if (!WQ.sleepTimerEnd) return null;
    const remaining = Math.max(0, WQ.sleepTimerEnd - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function updateSleepDisplay() {
    if (!WQ.panel) return;
    const btn = WQ.panel.querySelector("[data-action='sleep-toggle']");
    if (!btn) return;
    const label = btn.querySelector(".watchqueue-sleep-label");
    const isActive = Boolean(WQ.sleepTimerEnd);
    btn.classList.toggle("is-active", isActive);
    const timeText = isActive ? getSleepRemainingText() || "" : "";
    if (label) label.textContent = timeText;
    const stopBtn = WQ.panel.querySelector("[data-action='sleep-cancel']");
    if (stopBtn && isActive) stopBtn.textContent = `Stop timer · ${timeText}`;
  }

  function saveSleepTimerToStorage() {
    try { chrome.storage?.local?.set({ watchQueueSleepTimerEnd: WQ.sleepTimerEnd || 0 }); } catch {}
  }

  async function restoreSleepTimer() {
    try {
      const data = await chrome.storage?.local?.get(["watchQueueSleepTimerEnd"]);
      const end = data?.watchQueueSleepTimerEnd;
      if (end && end > Date.now()) {
        WQ.sleepTimerEnd = end;
        WQ.sleepTimerInterval = setInterval(sleepTimerTick, 1000);
      } else if (end) {
        chrome.storage?.local?.remove("watchQueueSleepTimerEnd");
      }
    } catch {}
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
      const hasProgress = item.lastWatchedSeconds > 0 || item.completed;
      return `<li class="watchqueue-row ${item.videoId === currentVideoId ? "watchqueue-row-current" : ""} ${item.completed ? "watchqueue-row-done" : ""}" draggable="true" data-index="${index}" data-video-id="${item.videoId}" data-search="${escapeHtml(searchKey)}">
          <span class="watchqueue-drag" title="Drag to reorder">⋮⋮</span>
          <div class="watchqueue-thumb-wrap"><img class="watchqueue-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" />${item.durationText ? `<span class="watchqueue-thumb-time">${escapeHtml(item.durationText)}</span>` : ""}<span class="watchqueue-progress-bar"><span style="width:${percentage}%"></span></span>${item.completed ? `<span class="watchqueue-done-badge" title="Watched">✓</span>` : ""}</div>
          <div class="watchqueue-row-main"><button class="watchqueue-title" type="button" data-action="resume" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</button><div class="watchqueue-meta"><span class="watchqueue-meta-channel">${escapeHtml(channel)}</span><span class="watchqueue-meta-progress">${progress}${item.completed ? " · Done" : ""}</span>${item.publishedText ? `<span class="watchqueue-meta-date">${escapeHtml(item.publishedText)}</span>` : ""}</div></div>
          <div class="watchqueue-row-actions">${hasProgress ? `<button class="watchqueue-icon-button watchqueue-reset-button" type="button" title="Reset timestamp" data-action="reset-progress">${toolbarIcon("reset")}</button>` : ""}<button class="watchqueue-icon-button" type="button" title="Remove" data-action="remove">×</button></div>
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

    const playlistRows = playlists.map((playlist) => {
      const plSearchKey = playlist.name.toLowerCase();
      return `<li class="watchqueue-playlist-row" data-playlist-id="${playlist.id}" data-search="${escapeHtml(plSearchKey)}">
      <button class="watchqueue-playlist-open" type="button" data-action="playlist-open" title="${escapeHtml(playlist.name)}">
        ${playlistThumbStack(playlist)}
        <span class="watchqueue-playlist-open-text"><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.videos?.length || 0} videos</span></span>
      </button>
      <button type="button" class="watchqueue-icon-button" data-action="playlist-add" title="Add to queue">${toolbarIcon("queueAdd")}</button>
      <button type="button" class="watchqueue-icon-button" data-action="playlist-delete" title="Delete playlist">×</button>
    </li>`;
    }).join("");

    const selectedPlaylistRows = selectedPlaylist ? (selectedPlaylist.videos || []).map((item, index) => {
      const progressEntry = state.progress?.[item.videoId] || item || {};
      const watched = Number(progressEntry.lastWatchedSeconds || 0);
      const duration = Number(progressEntry.durationSeconds || 0);
      const completed = Boolean(progressEntry.completed);
      const progressText = duration > 0
        ? `${formatTime(watched)} / ${formatTime(duration)}`
        : watched > 0
          ? `Saved ${formatTime(watched)}`
          : (item.durationText || "Not started");
      const displayTitle = isBadVideoTitle(item.title) ? `Video ${index + 1} · ${item.videoId}` : item.title;
      const channel = item.channelName || "YouTube";
      const isQueued = state.queue.some((queueItem) => queueItem.videoId === item.videoId);
      const hasProgress = watched > 0 || completed;
      const searchKey = `${displayTitle} ${channel}`.toLowerCase();
      return `<li class="watchqueue-row watchqueue-playlist-video-row ${completed ? "watchqueue-row-done" : ""}" draggable="true" data-video-id="${item.videoId}" data-index="${index}" data-search="${escapeHtml(searchKey)}">
        <span class="watchqueue-drag" title="Drag to reorder">⋮⋮</span>
        <div class="watchqueue-thumb-wrap"><img class="watchqueue-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" />${completed ? `<span class="watchqueue-done-badge" title="Watched">✓</span>` : ""}</div>
        <div class="watchqueue-row-main"><button class="watchqueue-title" type="button" data-action="playlist-video-play" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</button><div class="watchqueue-meta"><span class="watchqueue-meta-channel">${escapeHtml(channel)}</span><span class="watchqueue-meta-progress">${escapeHtml(progressText)}${completed ? " · Done" : ""}</span>${item.publishedText ? `<span class="watchqueue-meta-date">${escapeHtml(item.publishedText)}</span>` : ""}</div></div>
        <div class="watchqueue-row-actions">${hasProgress ? `<button class="watchqueue-icon-button watchqueue-reset-button" type="button" title="Reset timestamp" data-action="playlist-video-reset">${toolbarIcon("reset")}</button>` : ""}<button class="watchqueue-playlist-queue-button watchqueue-plus-button ${isQueued ? "is-queued" : ""}" type="button" title="${isQueued ? "Already in queue" : "Add video to queue"}" data-action="playlist-video-queue" ${isQueued ? "disabled" : ""}>${isQueued ? "✓" : "+"}</button></div>
      </li>`;
    }).join("") : "";

    const playlistPage = selectedPlaylist ? `
      <div class="watchqueue-playlist-detail">
        <div class="watchqueue-detail-header"><button type="button" class="watchqueue-detail-icon-btn" data-action="playlist-back" title="Back">${toolbarIcon("back")}</button><div><strong title="${escapeHtml(selectedPlaylist.name)}">${escapeHtml(selectedPlaylist.name)}</strong><span>${selectedPlaylist.videos?.length || 0} videos</span></div><button type="button" class="watchqueue-detail-icon-btn" data-action="playlist-rename" title="Rename">${toolbarIcon("edit")}</button></div>
        <div class="watchqueue-actions watchqueue-detail-actions"><button type="button" data-action="playlist-play-first" ${(selectedPlaylist.videos || []).length ? "" : "disabled"}>Play first</button><button type="button" data-action="playlist-add-all" ${(selectedPlaylist.videos || []).length ? "" : "disabled"}>Add all to queue</button><button type="button" data-action="playlist-delete-selected">Delete</button></div>
        ${(selectedPlaylist.videos || []).length > 3 ? `<div class="watchqueue-search-row"><div class="watchqueue-search"><span class="watchqueue-search-icon">⌕</span><input type="text" placeholder="Search in playlist" value="${escapeHtml(WQ.playlistVideoSearch)}" data-action="playlist-video-search" /></div></div>` : ""}
        <ul class="watchqueue-list watchqueue-playlist-video-list">${selectedPlaylistRows ? selectedPlaylistRows + `<li class="watchqueue-empty watchqueue-no-match" hidden><strong>No matches.</strong><span>Nothing in this playlist matches your search.</span></li>` : `<li class="watchqueue-empty"><strong>No videos found.</strong><span>Try importing the playlist from its YouTube playlist page.</span></li>`}</ul>
      </div>` : `
      <div class="watchqueue-scroll watchqueue-playlist-scroll">
        <div class="watchqueue-playlist-tools"><button type="button" data-action="import-current-playlist" ${!canImportCurrentYouTubePage(window.location.href) ? "disabled" : ""}>Import current YouTube playlist/show</button></div>
        ${playlists.length > 3 ? `<div class="watchqueue-search-row"><div class="watchqueue-search"><span class="watchqueue-search-icon">⌕</span><input type="text" placeholder="Search playlists" value="${escapeHtml(WQ.playlistSearch)}" data-action="playlist-search" /></div></div>` : ""}
        <ul class="watchqueue-playlist-list">${playlistRows ? playlistRows + `<li class="watchqueue-empty watchqueue-no-match" hidden><strong>No matches.</strong><span>No playlists match your search.</span></li>` : `<li class="watchqueue-empty"><strong>No custom playlists yet.</strong><span>Save your queue or import a YouTube playlist.</span></li>`}</ul>
      </div>`;

    const totalDuration = totalQueueDurationText(state.queue);
    const subtitle = state.queue.length
      ? `${state.queue.length} video${state.queue.length === 1 ? "" : "s"}${totalDuration ? ` · ${totalDuration}` : ""}`
      : "No videos yet";

    // Preserve scroll positions across re-render
    const scrollPositions = {};
    for (const sel of [".watchqueue-list", ".watchqueue-playlist-scroll", ".watchqueue-playlist-detail", ".watchqueue-settings-scroll", ".watchqueue-history-scroll", ".watchqueue-history-list", ".watchqueue-playlist-video-list"]) {
      const el = WQ.panel.querySelector(sel);
      if (el && el.scrollTop > 0) scrollPositions[sel] = el.scrollTop;
    }

    WQ.panel.innerHTML = `
      <div class="watchqueue-panel-header">
        <div class="watchqueue-brand"><span class="watchqueue-logo"><span>▶</span></span><div><h3>WatchQueue</h3><p>${subtitle}</p></div></div>
        <div class="watchqueue-header-buttons"><button class="watchqueue-close" type="button" aria-label="Close WatchQueue">×</button></div>
      </div>
      <div class="watchqueue-tabs">
        <button class="${WQ.activeTab === "queue" ? "active" : ""}" data-tab="queue">Queue</button>
        <button class="${WQ.activeTab === "playlists" ? "active" : ""}" data-tab="playlists">Lists</button>
        <button class="${WQ.activeTab === "history" ? "active" : ""}" data-tab="history">History</button>
        <button class="${WQ.activeTab === "settings" ? "active" : ""}" data-tab="settings">Settings</button>
      </div>

      <div class="watchqueue-tab-page ${WQ.activeTab !== "queue" ? "watchqueue-hidden" : ""}">
        ${(state.savedQueues || []).length > 0 ? `<div class="watchqueue-queue-selector">
          <div class="watchqueue-queue-radios">
            ${(state.savedQueues || []).map((sq, sqIdx) => `<label class="watchqueue-queue-radio ${sq.id === state.activeQueueId ? "is-active" : ""}" draggable="true" data-queue-id="${sq.id}" data-queue-index="${sqIdx}" title="${escapeHtml(sq.name)}"><input type="radio" name="wq-active-queue" value="${sq.id}" ${sq.id === state.activeQueueId ? "checked" : ""} /><span>${escapeHtml(sq.name)}</span><span class="watchqueue-queue-count">${(sq.id === state.activeQueueId ? state.queue : sq.queue || []).length}</span></label>`).join("")}
          </div>
          <div class="watchqueue-queue-selector-actions"><button type="button" data-action="new-queue" title="Create a new queue">+</button><button type="button" data-action="rename-queue" title="Rename active queue" ${!state.activeQueueId ? "disabled" : ""}>✎</button><button type="button" data-action="delete-queue" title="Delete active queue" ${!state.activeQueueId || (state.savedQueues || []).length < 2 ? "disabled" : ""}>×</button></div>
        </div>` : `<div class="watchqueue-queue-selector watchqueue-queue-selector-minimal"><button type="button" class="watchqueue-queue-new-btn" data-action="new-queue" title="Create additional named queues">+ New queue</button></div>`}
        <div class="watchqueue-control-row">
          <label class="watchqueue-switch"><input type="checkbox" ${state.queueMode ? "checked" : ""} data-action="queue-mode" /><span class="watchqueue-slider"></span><span class="watchqueue-switch-label">Queue Mode</span></label>
          <div class="watchqueue-sleep-wrap">
            <button type="button" class="watchqueue-tool-button watchqueue-tool-icon watchqueue-sleep-btn ${WQ.sleepTimerEnd ? "is-active" : ""}" data-action="sleep-toggle" title="${WQ.sleepTimerEnd ? "Sleep timer active" : "Set sleep timer"}">${toolbarIcon("sleep")}<span class="watchqueue-sleep-label">${WQ.sleepTimerEnd ? (getSleepRemainingText() || "") : ""}</span></button>
            <div class="watchqueue-sleep-popover ${WQ.sleepPopoverOpen ? "" : "watchqueue-hidden"}">
              <div class="watchqueue-sleep-grid">
                ${[15, 30, 45, 60, 90, 120].map((m) => `<button type="button" data-sleep-minutes="${m}">${m >= 60 ? `${m / 60}h` : `${m}m`}</button>`).join("")}
              </div>
              <div class="watchqueue-sleep-custom-row">
                <span class="watchqueue-sleep-custom-label">Custom</span>
                <select data-sleep-hours title="Hours">${Array.from({length: 13}, (_, i) => `<option value="${i}">${i}h</option>`).join("")}</select>
                <select data-sleep-mins title="Minutes">${[0,1,2,5,10,15,20,25,30,35,40,45,50,55].map((m) => `<option value="${m}">${m}m</option>`).join("")}</select>
                <button type="button" data-action="sleep-custom-start">Start</button>
              </div>
              <div class="watchqueue-sleep-option">
                <span>Close tab when timer ends</span>
                <label class="watchqueue-switch watchqueue-switch-compact"><input type="checkbox" ${settings().sleepCloseTab ? "checked" : ""} data-action="sleep-close-tab" /><span class="watchqueue-slider"></span></label>
              </div>
              ${WQ.sleepTimerEnd ? `<button type="button" class="watchqueue-sleep-stop" data-action="sleep-cancel">Stop timer · ${getSleepRemainingText() || "0:00"}</button>` : ""}
            </div>
          </div>
          <div class="watchqueue-mini-nav" title="Move through your queue"><button type="button" data-action="play-prev" ${!previousQueueItem || state.queue.length < 2 ? "disabled" : ""}>Prev</button><span>${currentQueueText}</span><button type="button" data-action="play-next" ${!nextQueueItem || state.queue.length < 2 ? "disabled" : ""}>Next</button></div>
        </div>
        <div class="watchqueue-search-row ${state.queue.length ? "" : "watchqueue-hidden"}">
          <div class="watchqueue-search"><span class="watchqueue-search-icon">⌕</span><input type="text" placeholder="Search queue" value="${escapeHtml(WQ.queueSearch)}" data-action="search" /></div>
          <button type="button" class="watchqueue-tool-button watchqueue-tool-icon" data-action="reverse" title="Reverse queue order" ${state.queue.length < 2 ? "disabled" : ""}>${toolbarIcon("reverse")}</button>
          <button type="button" class="watchqueue-tool-button watchqueue-tool-icon watchqueue-sync-icon ${state.settings?.loopQueue ? "is-active" : ""}" data-action="queue-loop-toggle" title="${state.settings?.loopQueue ? "Loop queue is on" : "Loop queue is off"}" aria-label="${state.settings?.loopQueue ? "Turn queue loop off" : "Turn queue loop on"}" aria-pressed="${state.settings?.loopQueue ? "true" : "false"}">${toolbarIcon("loop", Boolean(state.settings?.loopQueue))}</button>
          <button type="button" class="watchqueue-tool-button watchqueue-tool-icon watchqueue-sync-icon ${state.settings?.autoRemoveWatched ? "is-active" : ""}" data-action="queue-auto-remove-toggle" title="${state.settings?.autoRemoveWatched ? "Auto-remove watched is on" : "Auto-remove watched is off"}" aria-label="${state.settings?.autoRemoveWatched ? "Turn auto-remove watched off" : "Turn auto-remove watched on"}" aria-pressed="${state.settings?.autoRemoveWatched ? "true" : "false"}">${toolbarIcon("autoRemove", Boolean(state.settings?.autoRemoveWatched))}</button>
          <button type="button" class="watchqueue-tool-button watchqueue-tool-icon watchqueue-sync-icon ${state.settings?.shuffleQueue ? "is-active" : ""}" data-action="shuffle" title="${state.settings?.shuffleQueue ? "Shuffle is on" : "Shuffle is off"}" aria-label="${state.settings?.shuffleQueue ? "Turn shuffle off and restore previous order" : "Turn shuffle on"}" aria-pressed="${state.settings?.shuffleQueue ? "true" : "false"}" ${state.queue.length < 2 ? "disabled" : ""}>${toolbarIcon("shuffle", Boolean(state.settings?.shuffleQueue))}</button>
        </div>
        <ul class="watchqueue-list">${queueRows ? queueRows + noMatchMarkup : emptyQueueMarkup}</ul>
        <div class="watchqueue-actions"><button type="button" data-action="play-first" ${!state.queue.length ? "disabled" : ""}>Play first</button><button type="button" data-action="save-queue" ${!state.queue.length ? "disabled" : ""}>Save as playlist</button><button type="button" data-action="clear" ${!state.queue.length ? "disabled" : ""}>Clear</button></div>
      </div>

      <div class="watchqueue-tab-page ${WQ.activeTab !== "playlists" ? "watchqueue-hidden" : ""}">${playlistPage}</div>

      <div class="watchqueue-tab-page ${WQ.activeTab !== "history" ? "watchqueue-hidden" : ""}">${WQ.activeTab === "history" ? buildHistoryPage(state) : ""}</div>

      <div class="watchqueue-tab-page ${WQ.activeTab !== "settings" ? "watchqueue-hidden" : ""}">${WQ.activeTab === "settings" ? buildSettingsPage(state) : ""}</div>`;

    WQ.panel.querySelector(".watchqueue-close")?.addEventListener("click", () => { WQ.userOpenedPanel = false; WQ.panel.hidden = true; });
    WQ.panel.addEventListener("click", (event) => {
      if (WQ.sleepPopoverOpen && !event.target.closest(".watchqueue-sleep-wrap")) {
        WQ.sleepPopoverOpen = false;
        const popover = WQ.panel.querySelector(".watchqueue-sleep-popover");
        if (popover) popover.classList.add("watchqueue-hidden");
      }
    });
    WQ.panel.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", async () => { WQ.activeTab = button.dataset.tab; WQ.sleepPopoverOpen = false; if (WQ.activeTab !== "playlists") { WQ.selectedPlaylistId = null; WQ.playlistSearch = ""; WQ.playlistVideoSearch = ""; } if (WQ.activeTab !== "history") { WQ.historySearch = ""; } await renderPanel(); }));

    if (WQ.activeTab === "settings") {
      bindSettingsHandlers(state);
      restoreScrollPositions(WQ.panel, scrollPositions);
      return;
    }

    if (WQ.activeTab === "history") {
      // History search
      const historySearchInput = WQ.panel.querySelector("[data-action='history-search']");
      if (historySearchInput) {
        historySearchInput.addEventListener("input", () => {
          WQ.historySearch = historySearchInput.value;
          applyHistoryFilter();
        });
        applyHistoryFilter();
      }
      // History row handlers
      WQ.panel.querySelectorAll(".watchqueue-history-list .watchqueue-row").forEach((row) => {
        row.addEventListener("click", async (event) => {
          const action = event.target?.closest("[data-action]")?.dataset?.action;
          const videoId = row.dataset.videoId;
          if (!videoId) return;
          if (action === "history-play") await navigateToVideo({ videoId, lastWatchedSeconds: 0 });
          if (action === "history-reset") { await WatchQueueManager.resetVideoProgress(videoId); await renderPanel(); showToast("Timestamp reset"); }
        });
      });
      // Clear all history
      WQ.panel.querySelector("[data-action='history-clear-all']")?.addEventListener("click", async () => {
        const ok = await showConfirmDialog({ title: "Clear all history", message: "Remove all watch history? Queue and playlist data is kept.", confirmText: "Clear all", danger: true });
        if (!ok) return;
        await WatchQueueManager.clearAllProgress();
        await renderPanel();
        showToast("Watch history cleared");
      });
      restoreScrollPositions(WQ.panel, scrollPositions);
      return;
    }

    WQ.panel.querySelector("[data-action='queue-mode']")?.addEventListener("change", async () => { await WatchQueueManager.toggleQueueMode(); await renderPanel(); });

    // Sleep timer handlers
    WQ.panel.querySelector("[data-action='sleep-toggle']")?.addEventListener("click", (event) => {
      event.stopPropagation();
      WQ.sleepPopoverOpen = !WQ.sleepPopoverOpen;
      const popover = WQ.panel.querySelector(".watchqueue-sleep-popover");
      if (popover) popover.classList.toggle("watchqueue-hidden", !WQ.sleepPopoverOpen);
    });
    WQ.panel.querySelectorAll("[data-sleep-minutes]").forEach((btn) => {
      btn.addEventListener("click", () => startSleepTimer(Number(btn.dataset.sleepMinutes)));
    });
    WQ.panel.querySelector("[data-action='sleep-custom-start']")?.addEventListener("click", () => {
      const hours = Number(WQ.panel.querySelector("[data-sleep-hours]")?.value || 0);
      const mins = Number(WQ.panel.querySelector("[data-sleep-mins]")?.value || 0);
      const total = hours * 60 + mins;
      if (total > 0) startSleepTimer(total);
      else showToast("Pick a time first");
    });
    WQ.panel.querySelector("[data-action='sleep-close-tab']")?.addEventListener("change", async (event) => {
      await WatchQueueManager.updateSettings({ sleepCloseTab: event.target.checked });
      await loadSettings();
    });
    WQ.panel.querySelector("[data-action='sleep-cancel']")?.addEventListener("click", () => {
      clearSleepTimer();
      showToast("Sleep timer cancelled");
    });
    WQ.panel.querySelector("[data-action='play-first']")?.addEventListener("click", () => state.queue[0] && navigateToVideo(state.queue[0]));
    WQ.panel.querySelector("[data-action='play-prev']")?.addEventListener("click", () => previousQueueItem && navigateToVideo(previousQueueItem));
    WQ.panel.querySelector("[data-action='play-next']")?.addEventListener("click", () => nextQueueItem && navigateToVideo(nextQueueItem));
    WQ.panel.querySelector("[data-action='shuffle']")?.addEventListener("click", async () => {
      const enabled = !state.settings?.shuffleQueue;
      await WatchQueueManager.toggleShuffleQueue();
      await renderWidget();
      await renderPanel();
      showToast(enabled ? "Shuffle enabled" : "Shuffle disabled — original order restored");
    });
    WQ.panel.querySelector("[data-action='reverse']")?.addEventListener("click", async () => { await WatchQueueManager.reverseQueue(); await renderWidget(); await renderPanel(); showToast("Queue reversed"); });
    WQ.panel.querySelector("[data-action='queue-loop-toggle']")?.addEventListener("click", async () => {
      const enabled = !state.settings?.loopQueue;
      await WatchQueueManager.updateSettings({ loopQueue: enabled });
      await loadSettings();
      await renderPanel();
      showToast(enabled ? "Queue loop enabled" : "Queue loop disabled");
    });
    WQ.panel.querySelector("[data-action='queue-auto-remove-toggle']")?.addEventListener("click", async () => {
      const enabled = !state.settings?.autoRemoveWatched;
      await WatchQueueManager.updateSettings({ autoRemoveWatched: enabled });
      await loadSettings();
      if (enabled) await WatchQueueManager.removeCompletedFromQueue();
      await renderWidget();
      await renderPanel();
      showToast(enabled ? "Auto-remove enabled" : "Auto-remove disabled");
    });

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

    WQ.panel.querySelector("[data-action='playlist-back']")?.addEventListener("click", async () => { WQ.selectedPlaylistId = null; WQ.playlistVideoSearch = ""; await renderPanel(); });
    WQ.panel.querySelector("[data-action='playlist-rename']")?.addEventListener("click", async () => {
      if (!selectedPlaylist) return;
      const name = await showNameDialog({ title: "Rename playlist", label: "Playlist name", initialValue: selectedPlaylist.name, confirmText: "Rename" });
      if (!name) return;
      await WatchQueueManager.renameCustomPlaylist(selectedPlaylist.id, name);
      await renderPanel();
    });
    WQ.panel.querySelector("[data-action='playlist-play-first']")?.addEventListener("click", () => selectedPlaylist?.videos?.[0] && navigateToVideo(selectedPlaylist.videos[0]));
    WQ.panel.querySelector("[data-action='playlist-add-all']")?.addEventListener("click", async () => {
      if (!selectedPlaylist) return;
      const result = await pickQueueAndAddPlaylist(selectedPlaylist.id);
      if (!result) return;
      await renderWidget();
      await renderPanel();
      const suffix = result.queueName ? ` to "${result.queueName}"` : " to queue";
      showToast(`Added ${result.addedCount} videos${suffix}`);
    });
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
        if (action === "playlist-add") {
          const result = await pickQueueAndAddPlaylist(row.dataset.playlistId);
          if (!result) return;
          await renderWidget(); await renderPanel();
          const suffix = result.queueName ? ` to "${result.queueName}"` : " to queue";
          showToast(`Added ${result.addedCount} videos${suffix}`);
        }
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
          const result = await pickQueueAndAddVideo(item);
          if (!result) return;
          await renderWidget();
          await renderPanel();
          if (result.wasDuplicate) {
            showToast(result.queueName ? `Already in "${result.queueName}"` : "Already in queue");
          } else {
            showToast(result.queueName ? `Added to "${result.queueName}"` : "Added to queue");
          }
        }
        if (action === "playlist-video-reset") { await WatchQueueManager.resetVideoProgress(videoId); await renderPanel(); showToast("Timestamp reset"); }
      });
      // Drag-and-drop reorder for playlist videos
      row.addEventListener("dragstart", (event) => {
        if ((WQ.playlistVideoSearch || "").trim()) { event.preventDefault(); return; }
        row.classList.add("watchqueue-dragging");
        event.dataTransfer.setData("text/plain", row.dataset.index);
        event.dataTransfer.setData("wq-drag-type", "playlist-video");
      });
      row.addEventListener("dragend", () => row.classList.remove("watchqueue-dragging"));
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        if (!selectedPlaylist) return;
        if ((WQ.playlistVideoSearch || "").trim()) return;
        if (event.dataTransfer.getData("wq-drag-type") !== "playlist-video") return;
        const fromIndex = Number(event.dataTransfer.getData("text/plain"));
        const toIndex = Number(row.dataset.index);
        if (Number.isInteger(fromIndex) && Number.isInteger(toIndex) && fromIndex !== toIndex) {
          await WatchQueueManager.reorderPlaylistVideos(selectedPlaylist.id, fromIndex, toIndex);
          await renderPanel();
        }
      });
    });

    WQ.panel.querySelectorAll(".watchqueue-row[data-index]:not(.watchqueue-playlist-video-row)").forEach((row) => {
      row.addEventListener("click", async (event) => {
        const action = event.target?.closest("[data-action]")?.dataset?.action;
        const videoId = row.dataset.videoId;
        const item = state.queue.find((queueItem) => queueItem.videoId === videoId);
        if (action === "resume" && item) await navigateToVideo(item);
        if (action === "remove") { await WatchQueueManager.removeVideo(videoId); await renderWidget(); await renderPanel(); }
        if (action === "reset-progress") { await WatchQueueManager.resetVideoProgress(videoId); await renderPanel(); showToast("Timestamp reset"); }
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

    // Multi-queue handlers
    WQ.panel.querySelectorAll("input[name='wq-active-queue']").forEach((radio) => {
      radio.addEventListener("change", async () => {
        if (radio.value && radio.value !== state.activeQueueId) { await WatchQueueManager.switchQueue(radio.value); WQ.queueSearch = ""; await renderWidget(); await renderPanel(); showToast("Switched queue"); }
      });
    });
    // Queue radio drag-and-drop for reorder + merge
    let queueMergeTimer = null;
    let queueMergeTarget = null;
    function clearMergeIndicators() {
      WQ.panel.querySelectorAll(".watchqueue-queue-radio").forEach((el) => {
        el.classList.remove("watchqueue-merge-target");
        el.querySelector(".watchqueue-merge-badge")?.remove();
      });
    }
    WQ.panel.querySelectorAll(".watchqueue-queue-radio[draggable]").forEach((label) => {
      label.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("wq-queue-id", label.dataset.queueId);
        event.dataTransfer.setData("wq-queue-index", label.dataset.queueIndex);
        event.dataTransfer.effectAllowed = "move";
        label.classList.add("watchqueue-dragging");
      });
      label.addEventListener("dragend", () => {
        label.classList.remove("watchqueue-dragging");
        if (queueMergeTimer) { clearTimeout(queueMergeTimer); queueMergeTimer = null; }
        clearMergeIndicators();
        queueMergeTarget = null;
      });
      label.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const sourceId = event.dataTransfer.types.includes("wq-queue-id") ? "pending" : null;
        if (!sourceId) return;
        // Start merge timer when hovering over a different queue
        if (queueMergeTarget !== label.dataset.queueId) {
          if (queueMergeTimer) clearTimeout(queueMergeTimer);
          clearMergeIndicators();
          queueMergeTarget = label.dataset.queueId;
          queueMergeTimer = setTimeout(() => {
            label.classList.add("watchqueue-merge-target");
            // Inject a visible "Merge" badge
            if (!label.querySelector(".watchqueue-merge-badge")) {
              const badge = document.createElement("span");
              badge.className = "watchqueue-merge-badge";
              badge.textContent = "⤵ Merge";
              label.appendChild(badge);
            }
          }, 800);
        }
      });
      label.addEventListener("dragleave", () => {
        if (queueMergeTarget === label.dataset.queueId) {
          if (queueMergeTimer) { clearTimeout(queueMergeTimer); queueMergeTimer = null; }
          label.classList.remove("watchqueue-merge-target");
          label.querySelector(".watchqueue-merge-badge")?.remove();
          queueMergeTarget = null;
        }
      });
      label.addEventListener("drop", async (event) => {
        event.preventDefault();
        if (queueMergeTimer) { clearTimeout(queueMergeTimer); queueMergeTimer = null; }
        const sourceId = event.dataTransfer.getData("wq-queue-id");
        const sourceIndex = Number(event.dataTransfer.getData("wq-queue-index"));
        const targetId = label.dataset.queueId;
        const targetIndex = Number(label.dataset.queueIndex);
        const isMerge = label.classList.contains("watchqueue-merge-target");
        clearMergeIndicators();
        if (!sourceId || sourceId === targetId) return;
        // If the merge indicator is showing, merge the queues
        if (isMerge) {
          const sourceName = (state.savedQueues || []).find((q) => q.id === sourceId)?.name || "queue";
          const targetName = (state.savedQueues || []).find((q) => q.id === targetId)?.name || "queue";
          const ok = await showConfirmDialog({ title: "Merge queues", message: `Merge "${sourceName}" into "${targetName}"? The source queue will be removed and its videos added to the target.`, confirmText: "Merge" });
          if (!ok) return;
          await WatchQueueManager.mergeQueues(sourceId, targetId);
          WQ.queueSearch = "";
          await renderWidget();
          await renderPanel();
          showToast(`Merged into "${targetName}"`);
        } else {
          // Otherwise reorder
          if (Number.isInteger(sourceIndex) && Number.isInteger(targetIndex) && sourceIndex !== targetIndex) {
            await WatchQueueManager.reorderSavedQueues(sourceIndex, targetIndex);
            await renderPanel();
          }
        }
      });
    });
    WQ.panel.querySelector("[data-action='new-queue']")?.addEventListener("click", async () => {
      const name = await showNameDialog({ title: "New queue", label: "Queue name", initialValue: "My queue", confirmText: "Create" });
      if (!name) return;
      await WatchQueueManager.createNewQueue(name);
      WQ.queueSearch = "";
      await renderWidget();
      await renderPanel();
      showToast(`Created "${name}"`);
    });
    WQ.panel.querySelector("[data-action='rename-queue']")?.addEventListener("click", async () => {
      if (!state.activeQueueId) return;
      const current = (state.savedQueues || []).find((q) => q.id === state.activeQueueId);
      const name = await showNameDialog({ title: "Rename queue", label: "Queue name", initialValue: current?.name || "", confirmText: "Rename" });
      if (!name) return;
      await WatchQueueManager.renameQueue(state.activeQueueId, name);
      await renderPanel();
    });
    WQ.panel.querySelector("[data-action='delete-queue']")?.addEventListener("click", async () => {
      if (!state.activeQueueId) return;
      const current = (state.savedQueues || []).find((q) => q.id === state.activeQueueId);
      const ok = await showConfirmDialog({ title: "Delete queue", message: `Delete "${current?.name || "this queue"}"? Videos won't be lost from playlists.`, confirmText: "Delete" });
      if (!ok) return;
      await WatchQueueManager.deleteQueue(state.activeQueueId);
      WQ.queueSearch = "";
      await renderWidget();
      await renderPanel();
    });

    // Playlist list search handler
    const playlistSearchInput = WQ.panel.querySelector("[data-action='playlist-search']");
    if (playlistSearchInput) {
      playlistSearchInput.addEventListener("input", () => {
        WQ.playlistSearch = playlistSearchInput.value;
        applyPlaylistFilter();
      });
      applyPlaylistFilter();
    }

    // Playlist video search handler
    const playlistVideoSearchInput = WQ.panel.querySelector("[data-action='playlist-video-search']");
    if (playlistVideoSearchInput) {
      playlistVideoSearchInput.addEventListener("input", () => {
        WQ.playlistVideoSearch = playlistVideoSearchInput.value;
        applyPlaylistVideoFilter();
      });
      applyPlaylistVideoFilter();
    }

    // Restore scroll positions after re-render
    restoreScrollPositions(WQ.panel, scrollPositions);
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
    // Master toggle: if auto-next is disabled, don't auto-advance
    if (state.settings?.autoNextEnabled === false) return;
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
    await WatchQueueManager.pruneProgress();
    await restoreSleepTimer();
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
      if (!WQ.panel || WQ.panel.hidden) return;
      // Settings and history tabs don't need live updates from progress saves
      if (WQ.activeTab === "settings" || WQ.activeTab === "history") return;
      if (WQ.sleepPopoverOpen) return;
      // Don't re-render if any search input is focused — prevents scroll jump and focus loss
      const focused = document.activeElement;
      if (focused && focused.closest && focused.closest(".watchqueue-search, .watchqueue-search-row")) return;
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
