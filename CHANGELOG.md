# Changelog

## 0.1.1 — 2026-11-23

### Added
- Phone navigation: a move / draw switch on the tool strip. In move mode one finger scrolls the page; in draw mode one finger draws and two fingers move and zoom. Picking a pen or the eraser switches to draw mode.
- Momentum scrolling after a one-finger swipe.
- Double-tap to zoom in at that spot, double-tap again to fit the page.

### Changed
- Pages scroll like a normal scroll view: edges stop at the screen edge and a page smaller than the screen stays centered, so it can't get lost off-screen.
- Pages fit the full width on phones; the coordinate readout is hidden on small screens.
- Default host port in the compose file is now 8091.

## 0.1.0 — 2026-11-23

First release: the core notebook.

### Added
- Docker image (Node 22, no npm packages) with all data in a named volume.
- Sign-in: passkeys (Face ID), or password + authenticator code; 8 recovery codes; one-time setup code on first run; lockout after failed attempts; sign-in log; sign out everywhere.
- Notebooks, sections, one level of sub-sections and pages; notebook groups (stacks), cover colors, archive, pinned pages, search by name, move pages.
- Ink engine: fine-liner, technical pen, pencil, red-line pen and highlighter presets; pressure-shaped strokes; 0.25–1.0 mm line weights.
- Apple Pencil draws, fingers pan and zoom; palm rejection; two-finger tap undo, three-finger tap redo; long-press tool wheel; thumb strip with quick eraser; keyboard and mouse controls for laptops.
- Colors: engineering palette, custom and recent colors, show/hide ink by color, per-notebook color legend, ink adapts on dark and blueprint pages.
- Page styles at true scale: blank, lined, engineering graph (4/5/10 per inch, 5 mm), isometric grid and dots, dot grid, polar, semi-log, calc pad; border and title block; Letter, Tabloid and endless canvas; portrait/landscape; paper, blueprint and dark tones.
- Handwriting cleanup: smoothing and baseline straightening, with the original strokes kept and a compare view.
- Auto-save on every stroke, offline outbox, live sync between devices.
- Export: print / Save as PDF at true size (page or whole notebook), PNG, SVG, ink-only SVG, full JSON export; print test ruler.
- Installable on the iPad home screen; works offline.
- Modern engineering theme: dark graphite frame, light mode, IBM Plex fonts when installed.
