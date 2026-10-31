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

      const nextItem = {
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
      };

      const shuffleOriginalOrder = currentState.settings?.shuffleQueue
        ? [...(currentState.shuffleOriginalOrder || currentState.queue.map((item) => item.videoId)), nextItem.videoId]
        : currentState.shuffleOriginalOrder;

      return {
        ...currentState,
        queue: [...currentState.queue, nextItem],
        shuffleOriginalOrder
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
      queue: state.queue.filter((item) => item.videoId !== videoId),
      shuffleOriginalOrder: Array.isArray(state.shuffleOriginalOrder)
        ? state.shuffleOriginalOrder.filter((id) => id !== videoId)
        : state.shuffleOriginalOrder
    }));
  },

  async clearQueue() {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queue: [],
      shuffleOriginalOrder: null,
      settings: {
        ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}),
        ...(state.settings || {}),
        shuffleQueue: false
      }
    }));
  },

  async toggleShuffleQueue() {
    return WatchQueueStorage.updateState((state) => {
      const shuffleEnabled = Boolean(state.settings?.shuffleQueue);

      if (shuffleEnabled) {
        const originalOrder = Array.isArray(state.shuffleOriginalOrder) ? state.shuffleOriginalOrder : [];
        const queueById = new Map(state.queue.map((item) => [item.videoId, item]));
        const restoredQueue = [
          ...originalOrder.map((videoId) => queueById.get(videoId)).filter(Boolean),
          ...state.queue.filter((item) => !originalOrder.includes(item.videoId))
        ];

        return {
          ...state,
          queue: restoredQueue,
          shuffleOriginalOrder: null,
          settings: {
            ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}),
            ...(state.settings || {}),
            shuffleQueue: false
          }
        };
      }

      const originalOrder = state.queue.map((item) => item.videoId);
      const queue = [...state.queue];
      for (let i = queue.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }

      return {
        ...state,
        queue,
        shuffleOriginalOrder: originalOrder,
        settings: {
          ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}),
          ...(state.settings || {}),
          shuffleQueue: true
        }
      };
    });
  },

  async reverseQueue() {
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      queue: [...state.queue].reverse()
    }));
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
      // If timestamps are disabled, only track completion for auto-remove
      if (state.settings?.keepTimestamps === false && !completed) return state;

      const progressEntry = {
        lastWatchedSeconds: Math.floor(lastWatchedSeconds),
        durationSeconds: Math.floor(durationSeconds || 0),
        completed,
        updatedAt: Date.now()
      };

      const shouldAutoRemove = completed && state.settings?.autoRemoveWatched;

      return {
        ...state,
        progress: {
          ...state.progress,
          [videoId]: progressEntry
        },
        queue: shouldAutoRemove
          ? state.queue.filter((item) => item.videoId !== videoId)
          : state.queue.map((item) =>
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
  },

  // ---------- Add to a specific named queue ----------

  async addVideoToSpecificQueue(targetQueueId, video) {
    if (!targetQueueId || !video?.videoId) return { wasDuplicate: false };
    let wasDuplicate = false;
    await WatchQueueStorage.updateState((state) => {
      // If the target is the active queue, add to state.queue directly
      if (targetQueueId === state.activeQueueId) {
        const exists = state.queue.some((item) => item.videoId === video.videoId);
        if (exists) { wasDuplicate = true; return state; }
        const cleanedTitle = !watchQueueIsBadTitle(video.title) ? watchQueueCleanText(video.title) : `YouTube video ${video.videoId}`;
        const progress = state.progress?.[video.videoId] || {};
        const nextItem = {
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
        };
        return { ...state, queue: [...state.queue, nextItem] };
      }
      // Otherwise, add to the savedQueues entry
      const savedQueues = (state.savedQueues || []).map((sq) => {
        if (sq.id !== targetQueueId) return sq;
        const queue = sq.queue || [];
        if (queue.some((item) => item.videoId === video.videoId)) { wasDuplicate = true; return sq; }
        const cleanedTitle = !watchQueueIsBadTitle(video.title) ? watchQueueCleanText(video.title) : `YouTube video ${video.videoId}`;
        const progress = state.progress?.[video.videoId] || {};
        return {
          ...sq,
          queue: [...queue, {
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
          }],
          updatedAt: Date.now()
        };
      });
      return { ...state, savedQueues };
    });
    return { wasDuplicate };
  },

  async addVideosToSpecificQueue(targetQueueId, videos) {
    let addedCount = 0;
    let duplicateCount = 0;
    for (const video of videos) {
      const result = await this.addVideoToSpecificQueue(targetQueueId, video);
      if (result.wasDuplicate) duplicateCount += 1;
      else addedCount += 1;
    }
    return { addedCount, duplicateCount };
  },

  async addPlaylistToSpecificQueue(playlistId, targetQueueId) {
    const state = await WatchQueueStorage.getState();
    const playlist = (state.playlists || []).find((item) => item.id === playlistId);
    if (!playlist) return { addedCount: 0, duplicateCount: 0 };
    return this.addVideosToSpecificQueue(targetQueueId, playlist.videos || []);
  },

  // ---------- Multi-queue ----------

  async createNewQueue(name) {
    const id = `wq_q_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    return WatchQueueStorage.updateState((state) => {
      const savedQueues = [...(state.savedQueues || [])];
      // save current queue into its slot first
      if (state.activeQueueId) {
        const idx = savedQueues.findIndex((q) => q.id === state.activeQueueId);
        if (idx !== -1) savedQueues[idx] = { ...savedQueues[idx], queue: state.queue, shuffleOriginalOrder: state.shuffleOriginalOrder, updatedAt: Date.now() };
      } else if (state.queue.length) {
        // save current anonymous queue as "Default"
        savedQueues.unshift({ id: `wq_q_default_${Date.now()}`, name: "Default", queue: state.queue, shuffleOriginalOrder: state.shuffleOriginalOrder, createdAt: Date.now(), updatedAt: Date.now() });
      }
      savedQueues.push({ id, name: name || "New queue", queue: [], shuffleOriginalOrder: null, createdAt: Date.now(), updatedAt: Date.now() });
      return { ...state, savedQueues, activeQueueId: id, queue: [], shuffleOriginalOrder: null, settings: { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(state.settings || {}), shuffleQueue: false } };
    });
  },

  async switchQueue(queueId) {
    return WatchQueueStorage.updateState((state) => {
      const savedQueues = [...(state.savedQueues || [])];
      // save outgoing queue
      if (state.activeQueueId) {
        const idx = savedQueues.findIndex((q) => q.id === state.activeQueueId);
        if (idx !== -1) savedQueues[idx] = { ...savedQueues[idx], queue: state.queue, shuffleOriginalOrder: state.shuffleOriginalOrder, updatedAt: Date.now() };
      }
      // load incoming queue
      const target = savedQueues.find((q) => q.id === queueId);
      if (!target) return { ...state, savedQueues };
      return { ...state, savedQueues, activeQueueId: queueId, queue: target.queue || [], shuffleOriginalOrder: target.shuffleOriginalOrder || null, settings: { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(state.settings || {}), shuffleQueue: false } };
    });
  },

  async deleteQueue(queueId) {
    return WatchQueueStorage.updateState((state) => {
      const savedQueues = (state.savedQueues || []).filter((q) => q.id !== queueId);
      // if deleting the active queue, switch to the first remaining or create empty
      if (state.activeQueueId === queueId) {
        const fallback = savedQueues[0];
        return { ...state, savedQueues, activeQueueId: fallback ? fallback.id : null, queue: fallback ? (fallback.queue || []) : [], shuffleOriginalOrder: fallback ? (fallback.shuffleOriginalOrder || null) : null, settings: { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(state.settings || {}), shuffleQueue: false } };
      }
      return { ...state, savedQueues };
    });
  },

  async renameQueue(queueId, name) {
    const cleanedName = watchQueueCleanText(name);
    if (!queueId || !cleanedName) return WatchQueueStorage.getState();
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      savedQueues: (state.savedQueues || []).map((q) => q.id === queueId ? { ...q, name: cleanedName, updatedAt: Date.now() } : q)
    }));
  },

  // ---------- Reset progress ----------

  async resetVideoProgress(videoId) {
    if (!videoId) return;
    return WatchQueueStorage.updateState((state) => {
      const updatedProgress = { ...state.progress };
      delete updatedProgress[videoId];
      return {
        ...state,
        progress: updatedProgress,
        queue: state.queue.map((item) => item.videoId === videoId ? { ...item, lastWatchedSeconds: 0, durationSeconds: item.durationSeconds, completed: false } : item),
        playlists: (state.playlists || []).map((playlist) => ({
          ...playlist,
          videos: (playlist.videos || []).map((item) => item.videoId === videoId ? { ...item, lastWatchedSeconds: 0, completed: false } : item)
        }))
      };
    });
  },

  // ---------- Storage management ----------

  async pruneProgress() {
    return WatchQueueStorage.updateState((state) => {
      const retentionDays = (state.settings?.progressRetentionDays) || 90;
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const queueIds = new Set(state.queue.map((item) => item.videoId));
      const playlistIds = new Set((state.playlists || []).flatMap((pl) => (pl.videos || []).map((v) => v.videoId)));
      const savedQueueIds = new Set((state.savedQueues || []).flatMap((sq) => (sq.queue || []).map((v) => v.videoId)));
      const prunedProgress = {};
      for (const [videoId, entry] of Object.entries(state.progress || {})) {
        if (queueIds.has(videoId) || playlistIds.has(videoId) || savedQueueIds.has(videoId)) { prunedProgress[videoId] = entry; continue; }
        if ((entry.updatedAt || 0) >= cutoff) { prunedProgress[videoId] = entry; continue; }
      }
      return { ...state, progress: prunedProgress };
    });
  },

  async getProgressCount() {
    const state = await WatchQueueStorage.getState();
    return Object.keys(state.progress || {}).length;
  },

  async clearAllProgress() {
    return WatchQueueStorage.updateState((state) => ({ ...state, progress: {} }));
  },

  // ---------- Playlist video reorder ----------

  async reorderPlaylistVideos(playlistId, fromIndex, toIndex) {
    if (!playlistId || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return WatchQueueStorage.getState();
    return WatchQueueStorage.updateState((state) => ({
      ...state,
      playlists: (state.playlists || []).map((playlist) => {
        if (playlist.id !== playlistId) return playlist;
        const videos = [...(playlist.videos || [])];
        const [moved] = videos.splice(fromIndex, 1);
        videos.splice(toIndex, 0, moved);
        return { ...playlist, videos, updatedAt: Date.now() };
      })
    }));
  },

  // ---------- Saved queue reorder & merge ----------

  async reorderSavedQueues(fromIndex, toIndex) {
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return WatchQueueStorage.getState();
    return WatchQueueStorage.updateState((state) => {
      const savedQueues = [...(state.savedQueues || [])];
      // sync current queue into its slot first
      if (state.activeQueueId) {
        const idx = savedQueues.findIndex((q) => q.id === state.activeQueueId);
        if (idx !== -1) savedQueues[idx] = { ...savedQueues[idx], queue: state.queue, shuffleOriginalOrder: state.shuffleOriginalOrder, updatedAt: Date.now() };
      }
      const [moved] = savedQueues.splice(fromIndex, 1);
      savedQueues.splice(toIndex, 0, moved);
      return { ...state, savedQueues };
    });
  },

  async mergeQueues(sourceQueueId, targetQueueId) {
    if (!sourceQueueId || !targetQueueId || sourceQueueId === targetQueueId) return WatchQueueStorage.getState();
    return WatchQueueStorage.updateState((state) => {
      const savedQueues = [...(state.savedQueues || [])];
      // sync current queue into its slot first
      if (state.activeQueueId) {
        const idx = savedQueues.findIndex((q) => q.id === state.activeQueueId);
        if (idx !== -1) savedQueues[idx] = { ...savedQueues[idx], queue: state.queue, shuffleOriginalOrder: state.shuffleOriginalOrder, updatedAt: Date.now() };
      }
      const sourceIdx = savedQueues.findIndex((q) => q.id === sourceQueueId);
      const targetIdx = savedQueues.findIndex((q) => q.id === targetQueueId);
      if (sourceIdx === -1 || targetIdx === -1) return state;
      const sourceQueue = savedQueues[sourceIdx].queue || [];
      const targetQueue = savedQueues[targetIdx].queue || [];
      // Merge: add source videos to target, skip duplicates
      const existingIds = new Set(targetQueue.map((v) => v.videoId));
      const merged = [...targetQueue, ...sourceQueue.filter((v) => !existingIds.has(v.videoId))];
      savedQueues[targetIdx] = { ...savedQueues[targetIdx], queue: merged, updatedAt: Date.now() };
      // Remove source queue
      savedQueues.splice(sourceIdx, 1);
      // If source was active, switch to target
      const newActiveId = state.activeQueueId === sourceQueueId ? targetQueueId : state.activeQueueId;
      const activeSlot = savedQueues.find((q) => q.id === newActiveId);
      return {
        ...state,
        savedQueues,
        activeQueueId: newActiveId,
        queue: activeSlot ? (activeSlot.queue || []) : state.queue,
        shuffleOriginalOrder: activeSlot ? (activeSlot.shuffleOriginalOrder || null) : state.shuffleOriginalOrder,
        settings: { ...(window.WATCHQUEUE_DEFAULT_SETTINGS || {}), ...(state.settings || {}), shuffleQueue: false }
      };
    });
  },

  // ---------- Watch history ----------

  async getWatchHistory() {
    const state = await WatchQueueStorage.getState();
    const entries = Object.entries(state.progress || {})
      .filter(([, entry]) => entry.lastWatchedSeconds > 0 || entry.completed)
      .map(([videoId, entry]) => {
        // Try to find title info from queue or playlists
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
    return entries;
  },

  async clearProgressByAge(period) {
    return WatchQueueStorage.updateState((state) => {
      const now = Date.now();
      let cutoff;
      if (period === "hour") cutoff = now - 60 * 60 * 1000;
      else if (period === "day") cutoff = now - 24 * 60 * 60 * 1000;
      else if (period === "week") cutoff = now - 7 * 24 * 60 * 60 * 1000;
      else if (period === "month") cutoff = now - 30 * 24 * 60 * 60 * 1000;
      else return { ...state, progress: {} }; // "all"

      const prunedProgress = {};
      for (const [videoId, entry] of Object.entries(state.progress || {})) {
        if ((entry.updatedAt || 0) < cutoff) continue; // remove old entries
        prunedProgress[videoId] = entry;
      }
      return { ...state, progress: prunedProgress };
    });
  }
};
