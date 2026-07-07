function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function readDynamicTextViewModelH1(value) {
  if (!value || typeof value !== "object") return "";
  const direct = readTextRenderer(value.text) || readTextRenderer(value.title) || readTextRenderer(value.content) || readTextRenderer(value);
  if (direct) return direct;
  const queue = [value];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const candidate = readTextRenderer(node.text) || readTextRenderer(node.title) || readTextRenderer(node.content) || readTextRenderer(node.accessibilityText);
    if (candidate && candidate.length < 160) return candidate;
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return "";
}

function isBadTitle(value) {
  const text = cleanText(value);
  return !text || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) || /^YouTube video\s+[a-zA-Z0-9_-]{6,}$/.test(text) || text.toLowerCase() === "youtube";
}

function getImportableYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.youtube.com") return null;
    if (parsed.pathname === "/playlist" && parsed.searchParams.has("list")) {
      return { type: "playlist", url: `https://www.youtube.com/playlist?list=${encodeURIComponent(parsed.searchParams.get("list"))}` };
    }
    if (parsed.pathname.startsWith("/show/")) {
      return { type: "show", url: parsed.toString() };
    }
    return null;
  } catch {
    return null;
  }
}

function extractJsonAfterMarker(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf("{", markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

function bestThumbnail(thumbnails, videoId) {
  const list = thumbnails || [];
  return list[list.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function mergeVideo(videoMap, video) {
  if (!video?.videoId || video.videoId.length !== 11) return;
  const existing = videoMap.get(video.videoId) || {};
  videoMap.set(video.videoId, {
    videoId: video.videoId,
    title: !isBadTitle(video.title) ? video.title : existing.title || `YouTube video ${video.videoId}`,
    channelName: video.channelName || existing.channelName || "YouTube",
    thumbnailUrl: video.thumbnailUrl || existing.thumbnailUrl || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
    durationText: video.durationText || existing.durationText || "",
    publishedText: video.publishedText || existing.publishedText || ""
  });
}

function collectPlaylistVideosFromJson(root) {
  const videos = new Map();
  let h1Title = "";
  let headerTitle = "";
  let metaTitle = "";

  const ignoreTitle = (value) => {
    const text = cleanText(value).toLowerCase();
    return !text || text === "play all" || text === "shuffle" || text === "play" || text === "save" || text === "share";
  };

  const considerTitle = (bucket, value) => {
    const text = cleanText(value);
    if (ignoreTitle(text) || text.length > 180) return bucket;
    return bucket || text;
  };

  const visit = (node) => {
    if (!node || videos.size >= 500) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;

    if (node.dynamicTextViewModelH1) {
      h1Title = considerTitle(h1Title, readDynamicTextViewModelH1(node.dynamicTextViewModelH1));
    }

    // Only pull the title from known playlist-title locations, never from a video's node.title.
    headerTitle = considerTitle(headerTitle, readTextRenderer(node.header?.playlistHeaderRenderer?.title));
    metaTitle = considerTitle(metaTitle, readTextRenderer(node.metadata?.playlistMetadataRenderer?.title));
    metaTitle = considerTitle(metaTitle, readTextRenderer(node.microformat?.microformatDataRenderer?.title));
    if (node.pageHeaderRenderer?.pageTitle) {
      h1Title = considerTitle(h1Title, readTextRenderer(node.pageHeaderRenderer.pageTitle));
    }

    const renderer = node.playlistVideoRenderer || node.gridVideoRenderer || node.videoRenderer || node.compactVideoRenderer;
    if (renderer?.videoId && renderer.videoId.length === 11) {
      const title = readTextRenderer(renderer.title) || readTextRenderer(renderer.headline) || `YouTube video ${renderer.videoId}`;
      const channelName = readTextRenderer(renderer.shortBylineText) || readTextRenderer(renderer.longBylineText) || readTextRenderer(renderer.ownerText) || "YouTube";
      const durationText = readTextRenderer(renderer.lengthText) || readTextRenderer(renderer.thumbnailOverlays?.find((overlay) => overlay.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer?.text);
      const publishedText = readTextRenderer(renderer.publishedTimeText) || readTextRenderer(renderer.videoInfo);
      mergeVideo(videos, {
        videoId: renderer.videoId,
        title,
        channelName,
        thumbnailUrl: bestThumbnail(renderer.thumbnail?.thumbnails, renderer.videoId),
        durationText,
        publishedText
      });
    }

    Object.values(node).forEach(visit);
  };

  visit(root);
  return { videos: [...videos.values()], title: h1Title || headerTitle || metaTitle };
}

function collectPlaylistLinksFromHtml(html) {
  const videos = new Map();
  const watchLinkPattern = /href="\/watch\?([^"#]+)"/g;
  let match;
  while ((match = watchLinkPattern.exec(html)) && videos.size < 500) {
    const query = match[1].replace(/&amp;/g, "&");
    const params = new URLSearchParams(query);
    const videoId = params.get("v");
    if (!videoId || videoId.length !== 11) continue;
    mergeVideo(videos, {
      videoId,
      title: `YouTube video ${videoId}`,
      channelName: "YouTube",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationText: ""
    });
  }

  const jsonIdPattern = /"videoId":"([^"]{11})"/g;
  while ((match = jsonIdPattern.exec(html)) && videos.size < 500) {
    mergeVideo(videos, {
      videoId: match[1],
      title: `YouTube video ${match[1]}`,
      channelName: "YouTube",
      thumbnailUrl: `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`,
      durationText: ""
    });
  }

  return [...videos.values()];
}

async function fetchOEmbed(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`, { credentials: "omit" });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      videoId,
      title: cleanText(data.title || ""),
      channelName: cleanText(data.author_name || "YouTube"),
      thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationText: ""
    };
  } catch {
    return null;
  }
}

async function importPlaylist(url, fallbackTitle) {
  const importable = getImportableYouTubeUrl(url);
  if (!importable) throw new Error("Open a youtube.com/playlist?list= page or a youtube.com/show/ page first.");

  const response = await fetch(importable.url, { credentials: "include" });
  if (!response.ok) throw new Error("Could not fetch playlist page.");
  const html = await response.text();

  let videos = [];
  const docTitleMatch = html.match(/<title>([^<]{1,180})<\/title>/i);
  const docTitle = docTitleMatch ? cleanText(docTitleMatch[1].replace(/\s*-\s*YouTube\s*$/i, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')) : "";
  let title = cleanText(fallbackTitle || (importable.type === "show" ? "Imported show" : "Imported playlist"));
  const initialDataJson = extractJsonAfterMarker(html, "ytInitialData");
  if (initialDataJson) {
    try {
      const collected = collectPlaylistVideosFromJson(JSON.parse(initialDataJson));
      videos = collected.videos;
      // Prefer the JSON header title, then the document <title>, then the caller's fallback.
      title = cleanText(collected.title) || docTitle || title;
    } catch {
      videos = [];
    }
  }
  if ((!title || title === "Imported playlist" || title === "Imported show") && docTitle) title = docTitle;

  if (!videos.length) videos = collectPlaylistLinksFromHtml(html);

  const repaired = [];
  for (const video of videos.slice(0, 300)) {
    if (isBadTitle(video.title)) {
      const fetched = await fetchOEmbed(video.videoId);
      repaired.push(fetched ? { ...video, ...fetched, durationText: video.durationText || fetched.durationText || "" } : video);
    } else {
      repaired.push(video);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const video of repaired) {
    if (seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    deduped.push(video);
  }

  if (!deduped.length) throw new Error(importable.type === "show" ? "No videos found on this show page." : "No videos found in this playlist.");
  return { title, videos: deduped };
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url || !tab.url.includes('youtube.com')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'WATCHQUEUE_TOGGLE_WIDGET' });
  } catch (error) {
    // The content script may not be ready on this tab yet.
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WATCHQUEUE_CLOSE_TAB") {
    if (sender?.tab?.id) chrome.tabs.remove(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type !== "WATCHQUEUE_IMPORT_PLAYLIST") return false;
  importPlaylist(message.url, message.fallbackTitle)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || "Playlist import failed" }));
  return true;
});
