/* global chrome */

const WATCHQUEUE_DEFAULT_SETTINGS = {
  theme: "auto",              // "auto" | "light" | "dark"
  accent: "#ff0033",          // widget accent color
  resumeRewindSeconds: 7,     // rewind this many seconds before the saved timestamp
  minResumeSeconds: 15,       // only resume if the saved position is past this
  autoNextDelaySeconds: 10,   // wait before auto-playing the next queued video
  autoNextNearEnd: true,      // trigger auto-next when scrubbing near the end
  nearEndSeconds: 10,         // "near the end" window
  autoRemoveWatched: false,   // drop finished videos from the queue automatically
  loopQueue: false,           // wrap back to the top when the queue ends
  shuffleQueue: false,        // keep the queue in shuffled mode until toggled off
  showThumbnailButtons: true, // show the "+ Queue" hover button on thumbnails
  confirmClear: true,         // ask before clearing the whole queue
  widgetEdge: "right",        // "left" | "right" | "top" | "bottom" — which screen edge the widget docks to
  widgetStyle: "pill",        // "pill" | "tab" — floating widget shape
  panelOpacity: 100,          // 55..100 — panel background opacity (percent)
  progressRetentionDays: 90,  // prune saved timestamps older than this for videos not in any queue/playlist
  sleepCloseTab: false        // close tab when sleep timer ends (instead of just pausing)
};

const WATCHQUEUE_DEFAULT_STATE = {
  queueMode: true,
  queue: [],
  progress: {},
  currentVideoId: null,
  widgetPosition: null,
  widgetHidden: false,
  playlists: [],
  shuffleOriginalOrder: null,
  savedQueues: [],
  activeQueueId: null,
  settings: { ...WATCHQUEUE_DEFAULT_SETTINGS }
};

window.WATCHQUEUE_DEFAULT_SETTINGS = WATCHQUEUE_DEFAULT_SETTINGS;

function isWatchQueueExtensionContextAlive() {
  return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
}

function handleWatchQueueStorageError(error, fallback) {
  const message = String(error?.message || error || "");
  if (message.includes("Extension context invalidated") || message.includes("context invalidated")) {
    console.warn("WatchQueue: extension was reloaded. Refresh this YouTube tab to reconnect WatchQueue.");
    return fallback;
  }
  console.warn("WatchQueue storage error", error);
  return fallback;
}

window.WatchQueueStorage = {
  async getState() {
    if (!isWatchQueueExtensionContextAlive()) return { ...WATCHQUEUE_DEFAULT_STATE, settings: { ...WATCHQUEUE_DEFAULT_SETTINGS } };
    try {
      const data = await chrome.storage.local.get(["watchQueueState"]);
      const stored = data.watchQueueState || {};
      return {
        ...WATCHQUEUE_DEFAULT_STATE,
        ...stored,
        settings: { ...WATCHQUEUE_DEFAULT_SETTINGS, ...(stored.settings || {}) }
      };
    } catch (error) {
      return handleWatchQueueStorageError(error, { ...WATCHQUEUE_DEFAULT_STATE });
    }
  },

  async setState(nextState) {
    if (!isWatchQueueExtensionContextAlive()) return nextState;
    try {
      await chrome.storage.local.set({ watchQueueState: nextState });
      window.dispatchEvent(new CustomEvent("watchqueue:state-changed", { detail: nextState }));
    } catch (error) {
      handleWatchQueueStorageError(error, nextState);
    }
    return nextState;
  },

  async updateState(updater) {
    const current = await this.getState();
    const next = updater(current);
    await this.setState(next);
    return next;
  }
};
