# WatchQueue

A modern YouTube-themed Chrome extension that lets you build custom watch queues, save playback progress, manage playlists, and continue watching exactly where you left off.

WatchQueue adds a lightweight floating widget directly to YouTube, making it easy to queue videos, organize playlists, and automate playback without leaving the page.

---

# Features

## Queue Management

* Add videos directly from YouTube thumbnails with the **+ Queue** hover button.
* **Multiple named queues** — create, switch, rename, and delete named queues with a radio-button selector at the top of the Queue tab.
* Drag-and-drop queue reordering.
* Previous and Next queue navigation.
* Search the queue with live filtering.
* Shuffle (randomizes queue; turning off restores original order).
* Reverse queue order.
* Loop queue (wraps back to the top when the queue ends).
* Auto-remove watched videos.
* Display total queue duration.
* Save the current queue as a playlist.
* Toolbar icons: Reverse, Loop, Auto-remove, and Shuffle use consistent line-art SVG icons with on/off states.

---

## Playback

* Automatically save playback progress for any video you watch.
* Resume videos a few seconds before the last saved position.
* Resume timing is fully configurable.
* Progress is synchronized across the queue and all playlists.
* Queue Mode automatically plays the next queued video.
* Auto-next triggers when a video finishes or when scrubbing near the end.
* Configurable countdown before the next video begins.

---

## Sleep Timer

Set a sleep timer from the alarm-clock icon beside the Queue Mode toggle.

* **Presets:** 15m, 30m, 45m, 1h, 1.5h, 2h.
* **Custom time:** hour (0–12h) and minute (0, 1, 2, 5, 10, 15 … 55) dropdown selectors.
* **Close tab option:** optionally close the browser tab when the timer ends (uses the Chrome extension API for reliable tab closing).
* **Persistent:** the timer survives page refreshes — the end timestamp is saved to storage and restored on load.
* **Live countdown** on the toolbar button while the timer is running.
* When the timer ends, the video is paused using YouTube's own player API (`pauseVideo()`).
* The close-tab toggle is also accessible in Settings → Sleep timer.

---

## Watched / Done Indicators

* Videos that have been fully watched show a red **✓** badge on the top-left of their thumbnail.
* The video title dims to 60% opacity.
* The progress text shows "Done" in a muted accent color.
* Indicators appear in both the queue and playlist video views.

---

## Reset Timestamp

* A circular-arrow **reset** icon button appears on any video that has saved progress (in queue rows and playlist video rows).
* Clicking it clears the saved position, marks the video as not completed, and removes the progress entry — ready for a full rewatch.

---

## Playlist Management

WatchQueue playlists are stored separately from your queue, allowing you to organize collections without automatically queuing every video.

### Playlist Library

Each playlist supports:

* Rename (pencil icon)
* Delete
* Back navigation (arrow icon)
* Play first video
* Add entire playlist to the queue
* Queue individual videos (compact icon button)
* Play individual videos
* Queue status indicators (✓)
* Saved playback progress
* Upload dates
* Channel names
* Stacked thumbnail collage preview
* **Search within a playlist** (appears when a playlist has 4+ videos)

### Playlist List Search

* A search bar appears when you have 4+ playlists, filtering by playlist name.

### Playlist Import

Import directly from:

* `https://www.youtube.com/playlist?list=...`
* `https://www.youtube.com/show/...`

Imports include video titles, channel names, duration, thumbnails, and upload dates (when available).

### Import from YouTube

* A **+ Playlist** button appears beside YouTube's action buttons while watching a playlist.
* Every playlist and show card on channel pages receives a **+ List** button.
* Playlist cards in the feed only show **+ List** (no duplicate **+ Queue** button).

---

## Floating Widget

The floating widget can dock to any edge of the screen (Left, Right, Top, Bottom).

* Drag anywhere to snap to the nearest edge.
* Manual dock selection from Settings.
* Adaptive widget orientation.
* Panel automatically opens in the correct direction.
* Fixed-size panel with internal scrolling.
* Screen-edge clamping.
* Hide with the widget ✕ button; restore via the extension icon.

### Widget Styles

* Pill
* Tab

Dragging the widget also updates the selected dock edge inside Settings.

---

## Appearance

Modern YouTube-inspired interface featuring:

* Light, Dark, and Auto themes (follows YouTube)
* Roboto typography
* Rounded-rectangle buttons throughout
* Segmented Queue / Lists / Settings tabs
* Modern dialogs and toast notifications
* Live queue statistics

Customization options:

* Custom accent color (preset swatches + color picker)
* Panel opacity slider (40–100%)

---

## Settings

Everything updates live without requiring a page refresh.

### Appearance

* Theme (Auto / Light / Dark)
* Accent color
* Panel opacity

### Floating Widget

* Dock to edge (Left / Right / Top / Bottom)
* Widget style (Pill / Tab)

### Playback & Resume

* Resume rewind time
* Minimum saved playback before resuming

### Auto-next

* Countdown delay
* Near-end trigger toggle
* Near-end threshold
* Loop queue
* Auto-remove watched videos

### Interface

* Show/hide thumbnail **+ Queue** buttons
* Confirmation dialogs for destructive actions

### Sleep Timer

* Close tab when timer ends toggle

### Storage

* Progress retention period (7–365 days)
* Saved timestamp count
* Prune old timestamps (removes entries for videos not in any queue or playlist)
* Clear all timestamps

### Backup & Data

* Export queue, playlists, progress, and settings as JSON
* Import backups
* Reset widget position
* Restore default settings

---

# Installation

1. Download or clone the repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer Mode**.
4. Click **Load unpacked**.
5. Select the `WatchQueue` folder.
6. Open or refresh YouTube.

---

# Notes

* Playlist imports depend on the metadata YouTube exposes — very large or partially private playlists may not import completely.
* WatchQueue playlists are stored separately from the active queue. Use **Add all to queue** to load a saved playlist into the queue.
* Older queue items with incomplete titles are automatically repaired using YouTube metadata and oEmbed fallback.
* The sleep timer's close-tab feature uses the Chrome extension tabs API for reliable tab closure.
* Multiple queues share the same progress data — switching queues preserves all video timestamps.

---

# Changelog

## v0.4.0

### Added

* **Sleep timer** with preset and custom durations, close-tab option, persistent countdown across refreshes, and YouTube player API integration for reliable pausing.
* **Multiple named queues** with radio-button switching, create/rename/delete.
* **Watched/done indicators** — ✓ badge on thumbnails, dimmed titles, accent-tinted progress text.
* **Reset timestamp** button per video in queue and playlist views.
* **Playlist search** — search bar in playlist list (4+ playlists) and within playlist detail (4+ videos).
* **Storage management** — progress retention slider, prune old timestamps, clear all timestamps.
* **Close tab via extension API** — background script handler for reliable tab closing.

### Changed

* All buttons changed from pill shapes to rounded rectangles for a modern look.
* Improved toolbar icons: alarm clock for sleep, queue-add icon for playlists, pencil for rename, arrow for back.
* Playlist rows use compact icon buttons instead of text labels ("Queue" → icon, "Rename" → pencil).
* Playlist cards in the feed no longer show a duplicate **+ Queue** under the **+ List** button.
* Done-progress text uses a muted accent mix instead of full accent color.
* Playlist queue buttons (+ / ✓) sized down to match other icon buttons.

## v0.3.5

### Changed

* Updated Reverse, Loop, Auto-remove watched, and Shuffle icons to consistent minimalist line-art style.
* Added true Shuffle on/off behavior with order preservation.

## v0.3.4

### Changed

* Added Loop and Auto-remove watched icon controls to the queue toolbar.
* Queue-panel icon controls synchronized with Settings values.

## v0.3.3

### Added

* Improved playlist title detection, upload dates, reverse button, queue sorting.
* Custom accent color picker, panel opacity slider, stacked playlist thumbnails.
* **+ List** buttons on channel playlist/show cards, **+ Playlist** on watch pages.
* Live queue filtering, compact playlist add buttons, improved readability.

## v0.3.0

### Added

* Complete UI redesign, Settings page, queue search/shuffle/loop.
* Auto-remove watched, total queue duration, confirmation dialogs, JSON backup.

---

## Current Limitations

* **+ Queue** overlays are intentionally hidden on playlist cards that already have a **+ List** button.
* Playlist imports depend on YouTube's available metadata and may not include every hidden or dynamically loaded video.
* The sleep timer's close-tab feature requires the extension to have `tabs` permission.
