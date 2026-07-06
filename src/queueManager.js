/* global WatchQueueStorage */

function watchQueueCleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function watchQueueIsBadTitle(value) {
  const text = watchQueueCleanText(value);
  return !text || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) || /^YouTube video\s+[a-zA-Z0-9_-]{6,}$/.test(text) || text.toLowerCase() === "youtube";
}

window.WatchQueueManager = {
  async addVideo(video) {
    let wasDuplicate = false;

    const state = await WatchQueueStorage.updateState((currentState) => {
      const exists = currentState.queue.some((item) => item.videoId === video.videoId);
      const cleanedTitle = !watchQueueIsBadTitle(video.title) ? watchQueueCleanText(video.title) : `YouTube video ${video.videoId}`;

      if (exists) {
        wasDuplicate = true;
        return {
          ...currentState,
          queue: currentState.queue.map((item) =>
            item.videoId === video.videoId
              ? {
                  ...item,
                  title: !watchQueueIsBadTitle(cleanedTitle) ? cleanedTitle : item.title,
                  channelName: video.channelName || item.channelName,
                  thumbnailUrl: video.thumbnailUrl || item.thumbnailUrl,
                  durationText: video.durationText || item.durationText,
                  publishedText: video.publishedText || item.publishedText || ""
                }
              : item
          )
        };
      }

      const progress = currentState.progress?.[video.videoId] || {};

      return {
        ...currentState,
        queue: [
          ...currentState.queue,
          {
            videoId: video.videoId,
            title: cleanedTitle || "Untitled video",
            channelName: video.channelName || "YouTube",
            thumbnailUrl: video.thumbnailUrl || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
            durationText: video.durationText || "",
            publishedText: video.publishedText || "",
            lastWatchedSeconds: progress.lastWatchedSeconds || 0,
            durationSeconds: progress.durationSeconds || 0,
            completed: progress.completed || false,
            addedAt: Date.now()
          }
        ]
      };
    });

    return { state, wasDuplicate };
  },

  async addVideos(videos) {
    let addedCount = 0;
    let duplicateCount = 0;
    for (const video of videos) {
      const result = await this.addVideo(video);
      if (result.wasDuplicate) duplicateCount += 1;
      else addedCount += 1;
    }
    return { addedCount, duplicateCount };
  },

  async removeVideo(videoId) {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queue: state.queue.filter((item) => item.videoId !== videoId)
    }));
  },

  async clearQueue() {
    return WatchQueueStorage.updateState((state) => ({ ...state, queue: [] }));
  },

  async shuffleQueue() {
    return WatchQueueStorage.updateState((state) => {
      const queue = [...state.queue];
      for (let i = queue.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      return { ...state, queue };
    });
  },

  async reverseQueue() {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queue: [...state.queue].reverse()
    }));
  },

  async sortQueue(by = "title") {
    const parseDuration = (item) => {
      if (Number(item.durationSeconds) > 0) return Number(item.durationSeconds);
      const text = String(item.durationText || "").trim();
      if (!text) return 0;
      const parts = text.split(":").map((n) => Number(n));
      if (parts.some((n) => Number.isNaN(n))) return 0;
      return parts.reduce((acc, n) => acc * 60 + n, 0);
    };
    const parseUpload = (item) => {
      const text = String(item.publishedText || "").toLowerCase();
      const match = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
      if (!match) return 0;
      const amount = Number(match[1]);
      const unitMs = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[match[2]] || 0;
      return Date.now() - amount * unitMs; // approximate upload timestamp
    };
    return WatchQueueStorage.updateState((state) => {
      const queue = [...state.queue];
      if (by === "title") {
        queue.sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base", numeric: true }));
      } else if (by === "date") {
        // newest upload first; unknown dates sink to the bottom
        queue.sort((a, b) => (parseUpload(b) || 0) - (parseUpload(a) || 0));
      } else if (by === "time") {
        // longest duration first; unknown durations sink to the bottom
        queue.sort((a, b) => (parseDuration(b) || 0) - (parseDuration(a) || 0));
      }
      return { ...state, queue };
    });
  },

  async removeCompletedFromQueue() {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queue: state.queue.filter((item) => !item.completed)
    }));
  },

  async updateSettings(partial) {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      settings: {
        ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}),
        ...(state.settings || {}),
        ...(partial || {})
      }
    }));
  },

  async resetSettings() {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      settings: { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}) }
    }));
  },

  async reorderQueue(fromIndex, toIndex) {
    return WatchQueueStorage.updateState((state) => {
      const queue = [...state.queue];
      const [moved] = queue.splice(fromIndex, 1);
      queue.splice(toIndex, 0, moved);
      return { ...state, queue };
    });
  },

  async toggleQueueMode() {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queueMode: !state.queueMode
    }));
  },

  async saveProgress(videoId, lastWatchedSeconds, durationSeconds) {
    if (!videoId || Number.isNaN(lastWatchedSeconds)) return;

    const completed = durationSeconds > 0 && lastWatchedSeconds / durationSeconds >= 0.96;

    return WatchQueueStorage.updateState((state) => {
      const progressEntry = {
        lastWatchedSeconds: Math.floor(lastWatchedSeconds),
        durationSeconds: Math.floor(durationSeconds || 0),
        completed,
        updatedAt: Date.now()
      };

      return {
        ...state,
        progress: {
          ...state.progress,
          [videoId]: progressEntry
        },
        queue: state.queue.map((item) =>
          item.videoId === videoId
            ? {
                ...item,
                lastWatchedSeconds: progressEntry.lastWatchedSeconds,
                durationSeconds: progressEntry.durationSeconds,
                completed: progressEntry.completed
              }
            : item
        ),
        playlists: (state.playlists || []).map((playlist) => ({
          ...playlist,
          videos: (playlist.videos || []).map((item) =>
            item.videoId === videoId
              ? {
                  ...item,
                  lastWatchedSeconds: progressEntry.lastWatchedSeconds,
                  durationSeconds: progressEntry.durationSeconds,
                  completed: progressEntry.completed
                }
              : item
          )
        }))
      };
    });
  },

  async markCompleted(videoId) {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queue: state.queue.map((item) =>
        item.videoId === videoId ? { ...item, completed: true } : item
      ),
      progress: {
        ...state.progress,
        [videoId]: {
          ...(state.progress[videoId] || {}),
          completed: true,
          updatedAt: Date.now()
        }
      }
    }));
  },

  getNextVideo(state, currentVideoId) {
    if (!state.queue.length) return null;
    const loop = state.settings?.loopQueue;
    const currentIndex = state.queue.findIndex((item) => item.videoId === currentVideoId);
    if (currentIndex === -1) return state.queue.find((item) => !item.completed) || state.queue[0] || null;
    const after = state.queue.slice(currentIndex + 1).find((item) => !item.completed);
    if (after) return after;
    if (loop) {
      // wrap around: first unwatched from the top, otherwise the very first video
      return state.queue.slice(0, currentIndex).find((item) => !item.completed) || state.queue[0] || null;
    }
    return null;
  },

  getNextQueueVideo(state, currentVideoId) {
    if (!state.queue.length) return null;
    const currentIndex = state.queue.findIndex((item) => item.videoId === currentVideoId);
    if (currentIndex === -1) return state.queue[0];
    return state.queue[currentIndex + 1] || state.queue[0] || null;
  },

  getPreviousQueueVideo(state, currentVideoId) {
    if (!state.queue.length) return null;
    const currentIndex = state.queue.findIndex((item) => item.videoId === currentVideoId);
    if (currentIndex === -1) return state.queue[0];
    return state.queue[currentIndex - 1] || state.queue[state.queue.length - 1] || null;
  },

  async saveWidgetPosition(position) {
    const allowedEdges = ["left", "right", "top", "bottom"];
    const edge = allowedEdges.includes(position?.edge)
      ? position.edge
      : (position?.side === "left" ? "left" : position?.side === "top" ? "top" : position?.side === "bottom" ? "bottom" : "right");
    const snapped = {
      edge,
      side: edge, // kept for backward compatibility
      offset: Number.isFinite(Number(position?.offset)) ? Number(position.offset) : Number(position?.y || 120)
    };
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      widgetPosition: snapped
    }));
  },


  async setWidgetHidden(hidden) {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      widgetHidden: Boolean(hidden)
    }));
  },

  async updateVideoMetadata(video) {
    if (!video?.videoId) return WatchQueueStorage.getState();
    const cleanedTitle = !watchQueueIsBadTitle(video.title) ? watchQueueCleanText(video.title) : "";
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queue: state.queue.map((item) =>
        item.videoId === video.videoId
          ? {
              ...item,
              title: cleanedTitle || item.title,
              channelName: video.channelName || item.channelName,
              thumbnailUrl: video.thumbnailUrl || item.thumbnailUrl,
              durationText: video.durationText || item.durationText,
              publishedText: video.publishedText || item.publishedText || ""
            }
          : item
      ),
      playlists: (state.playlists || []).map((playlist) => ({
        ...playlist,
        videos: (playlist.videos || []).map((item) =>
          item.videoId === video.videoId
            ? {
                ...item,
                title: cleanedTitle || item.title,
                channelName: video.channelName || item.channelName,
                thumbnailUrl: video.thumbnailUrl || item.thumbnailUrl,
                durationText: video.durationText || item.durationText,
                publishedText: video.publishedText || item.publishedText || ""
              }
            : item
        )
      }))
    }));
  },

  async createCustomPlaylist(name, videos = []) {
    const playlist = {
      id: `wq_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      name: name || "Untitled playlist",
      videos,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await WatchQueueStorage.updateState((state) => ({
      ...state,
      playlists: [...(state.playlists || []), playlist]
    }));
    return playlist;
  },

  async deleteCustomPlaylist(playlistId) {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      playlists: (state.playlists || []).filter((playlist) => playlist.id !== playlistId)
    }));
  },

  async renameCustomPlaylist(playlistId, name) {
    const cleanedName = watchQueueCleanText(name);
    if (!playlistId || !cleanedName) return WatchQueueStorage.getState();
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      playlists: (state.playlists || []).map((playlist) =>
        playlist.id === playlistId
          ? { ...playlist, name: cleanedName, updatedAt: Date.now() }
          : playlist
      )
    }));
  },

  async addQueueToCustomPlaylist(name) {
    const state = await WatchQueueStorage.getState();
    return this.createCustomPlaylist(name || `Saved queue ${new Date().toLocaleDateString()}`, state.queue);
  },

  async addPlaylistToQueue(playlistId) {
    const state = await WatchQueueStorage.getState();
    const playlist = (state.playlists || []).find((item) => item.id === playlistId);
    if (!playlist) return { addedCount: 0, duplicateCount: 0 };
    return this.addVideos(playlist.videos || []);
  }
};
