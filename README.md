# WatchQueue

A modern YouTube-themed Chrome extension that lets you build a custom watch queue, save playback progress, manage playlists, and continue watching exactly where you left off.

WatchQueue adds a lightweight floating widget directly to YouTube, making it easy to queue videos, organize playlists, and automate playback without leaving the page.

---

# Features

## Queue Management

* Add videos directly from YouTube video thumbnails.
* Prevent duplicate **+ Queue** buttons on watch-page suggestion links.
* Drag-and-drop queue reordering.
* Previous and Next queue navigation.
* Search the queue with live filtering.
* Toggle Shuffle from the queue panel. Turning Shuffle on randomizes the current queue; turning it off restores the order that existed before shuffle was enabled.
* Reverse queue order.
* Display total queue duration.
* Toggle queue looping directly from the queue panel with icon controls.
* Reverse, Loop, Auto-remove, and Shuffle use matching minimalist line-art icons.
* Loop uses separate off/on icons: a continuous oval loop when enabled and the same icon with a diagonal strikethrough when disabled.
* Toggle automatic removal of watched videos directly from the queue panel with a matching line-style icon control.
* Auto-remove uses a trash-can icon when enabled and a trash-can icon with a small x when disabled.
* Shuffle uses a crossed-arrow icon when enabled and the same icon with a diagonal strikethrough when disabled.
* Queue-panel Loop and Auto-remove icon controls stay synchronized with Settings.

---

## Playback

* Automatically save playback progress.
* Resume videos a few seconds before the last saved position.
* Resume timing is fully configurable.
* Progress is synchronized with matching videos stored inside WatchQueue playlists.
* Queue Mode automatically plays the next queued video.
* Auto-next can trigger:

  * when a video finishes
  * when skipping near the end of a video
* Configurable countdown before the next video begins.

---

## Playlist Management

WatchQueue playlists are stored separately from your queue, allowing you to organize collections without automatically queuing every video.

### Playlist Library

Each playlist supports:

* Rename
* Delete
* Back navigation
* Play first video
* Add entire playlist to the queue
* Queue individual videos
* Play individual videos
* Queue status indicators (✓ Queue)
* Saved playback progress
* Upload dates
* Channel names
* Stacked thumbnail collage preview

### Playlist Import

Import directly from:

* `https://www.youtube.com/playlist?list=...`
* `https://www.youtube.com/show/...`

Imports include:

* Playlist title
* Video titles
* Channel names
* Duration
* Thumbnails
* Upload dates (when available)

Playlist titles are extracted using multiple metadata sources to avoid incorrect names.

### Import from YouTube

WatchQueue can also save playlists directly from YouTube.

#### While watching a playlist

A **+ Playlist** button appears beside YouTube's action buttons and opens a naming dialog before saving the playlist.

#### Channel Playlists pages

Every playlist and show card receives a **+ List** button, including cards that use `/watch?...&list=` links.

---

## Floating Widget

The floating widget can dock to any edge of the screen:

* Left
* Right
* Top
* Bottom

Features include:

* Drag anywhere to snap to the nearest edge.
* Manual dock selection from Settings.
* Adaptive widget orientation.
* Panel automatically opens in the correct direction.
* Fixed-size panel.
* Internal scrolling.
* Screen-edge clamping.
* Hide with the widget ✕ button.
* Restore by clicking the extension icon.

### Widget Styles

* Pill
* Tab

Dragging the widget also updates the selected dock edge inside Settings.

---

## Appearance

Modern YouTube-inspired interface featuring:

* Light theme
* Dark theme
* Auto theme (follows YouTube)
* Roboto typography
* Redesigned cards
* Segmented Queue / Lists / Settings tabs
* Refreshed queue overlays
* Modern dialogs
* Live queue statistics

Customization options include:

* Custom accent color
* Panel opacity slider

---

## Settings

Everything updates live without requiring a page refresh.

### Appearance

* Theme
* Accent color
* Panel opacity

### Playback & Resume

* Resume rewind time
* Minimum saved playback time before prompting

### Auto-next

* Countdown delay
* Near-end trigger
* Near-end threshold
* Loop queue
* Auto-remove watched videos

### Interface

* Enable or disable thumbnail **+ Queue** buttons
* Confirmation dialogs for destructive actions

### Backup & Data

* Export queue, playlists, and settings
* Import backups
* Reset widget position
* Restore default settings

---

# Installation

1. Download or clone the repository.
2. Open Chrome.
3. Navigate to `chrome://extensions/`.
4. Enable **Developer Mode**.
5. Click **Load unpacked**.
6. Select the `watchqueue-extension` folder.
7. Open or refresh YouTube.

---

# Notes

* Playlist imports depend on the metadata YouTube exposes.
* Very large playlists or playlists containing hidden/private videos may not import completely.
* WatchQueue playlists are stored separately from the active queue.
* Use **Add all to queue** whenever you want an entire saved playlist added to the queue.
* Older queue items with incomplete titles are automatically repaired when possible using YouTube metadata and oEmbed fallback.

---

# Changelog

## v0.3.5

### Changed

* Updated Reverse, Loop, Auto-remove watched, and Shuffle icons to use a consistent minimalist line-art style based on the requested icon descriptions.
* Added true Shuffle on/off behavior: enabling Shuffle randomizes the queue and saving the previous order; disabling Shuffle restores that previous order.
* Added separate Shuffle on/off icons with a diagonal strikethrough for the disabled state.
* README updated for the new icon and shuffle behavior.

## v0.3.4

### Changed

* Removed queue sorting from the queue toolbar.
* Added Loop and Auto-remove watched icon controls directly to the queue panel.
* Loop now uses distinct matching line-style off/on icons in the queue toolbar.
* Auto-remove watched now uses matching line-style off/on icons instead of emoji.
* Queue-panel icon controls now update the same Settings values, keeping both locations synchronized.
* README updated to reflect the queue toolbar changes.

## v0.3.3

### Added

* More reliable playlist title detection.
* Upload dates shown in queue and playlist views.
* Reverse queue button.
* Queue sorting (Name, Upload Date, Duration).
* Vertical Queue label for side-tab widgets.
* Automatic Settings synchronization when dragging the widget.
* Custom accent color picker.
* Panel opacity slider.
* Stacked playlist thumbnail previews.
* **+ List** buttons on channel playlist/show cards.
* **+ Playlist** button while watching playlist videos.
* Live queue filtering that keeps search focus.
* Compact playlist add button (+ / ✓).
* Separate channel and progress lines for improved readability.

### Fixed

* `insertBefore ... not a child` errors.
* Stable watch-page playlist button placement.
* More reliable playlist title importing.

---

## v0.3.2

### Added

* Redesigned Pill and Tab widgets.
* Better widget borders.
* Improved badge positioning.
* **+ List** buttons for playlist cards using `/watch?...&list=` links.

### Fixed

* Duplicate **+ Playlist** buttons.
* Playlist-panel insertion issues.
* Guarded DOM insertion to prevent `insertBefore` crashes.

---

## v0.3.1

### Added

* Widget docking on all four screen edges.
* Automatic edge snapping.
* Dock selection in Settings.
* Pill and Tab widget styles.
* Adaptive panel opening direction.

---

## v0.3.0

### Added

* Complete UI redesign.
* Dedicated Settings page.
* Queue search.
* Queue shuffle.
* Queue loop.
* Auto-remove watched videos.
* Total queue duration.
* Confirmation dialogs.
* JSON backup import/export.

### Improved

* Live theme switching.
* Resume timing now uses Settings.
* Auto-next countdown reflects configured delay.
* Accent colors apply consistently throughout the extension.

---

## v0.2.0

* Stabilized watch-page **+ Playlist** button placement.
* Improved playlist title detection.
* Larger panel.
* Improved spacing and layout.

---

## v0.1.9

* Safer handling of extension reloads.
* Playlist detail shows saved playback progress.
* Playlist videos display ✓ Queue status.
* Improved watch-page playlist button placement.

---

## Current Limitations

* Playlist card **+ Playlist** buttons remain disabled.
* **+ Queue** overlays are intentionally disabled on channel Playlist pages to avoid UI conflicts.
* Playlist imports depend on YouTube's available metadata and may not include every hidden or dynamically loaded video.
