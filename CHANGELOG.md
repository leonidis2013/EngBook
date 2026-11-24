# Changelog

## 0.4.0 — 2026-11-23

### Added
- **Getting started checklist** on Home for first-time setup (Home Screen install, Face ID passkey, your name, lettering and paper, handwriting training, Pencil moves, first scaled drawing, printer scale, backups). Steps tick themselves off; reopen it from Settings → Data.
- **Uppercase engineering lettering** (default) or everyday handwriting, in Settings.
- **Much stronger handwriting cleanup:** crisp straight strokes for uppercase letters, upright letters, even letter heights on one baseline, level words.
- **Align writing to rows and grid lines** (on by default; switch in Settings).
- **Snap while drawing:** in Dimensional mode the clean shape and its size show live as you draw.
- **Type a real size into a dimension:** tap a dimension with the ↔ tool, type 3", 76.2 mm or 3'-6", and resize the shape (its other dimensions follow) or just change the label.
- **Pens with character:** grainy graphite pencil that shades wider when the Pencil is tilted, bold felt-tip marker, crisp technical pen, flat chisel highlighter.
- **Drag the tool strip anywhere** by its grip; double-tap the grip to put it back.
- **Smarter, smaller handwriting training:** compact boxes, uppercase-first order, a "Words & labels" set (48 VDC, Ø6.5 THRU, SEE DWG A-101 …), and a writing profile (slant, steadiness) that tunes cleanup.

### Changed
- Settings moved from the top bar to the bottom of the left menu.
- Choosing the lasso (or eraser / dimension) no longer leaves a pen highlighted.

## 0.3.2 — 2026-11-23

### Changed
- New boot screen: a quick engineering sketch of the EngBook logo and wordmark (outline, ruled lines, signal trace, then the name drawn and filled, with a dimension line and version). Larger, higher contrast, and shown long enough to see (about 1.9 s). Still pure SVG/CSS.
- Compose file uses `pull_policy: always` so Stop / Start in TrueNAS updates the app.

## 0.3.1 — 2026-11-23

### Added
- **Settings → Data → Reload app**: fetches the newest app files from your server and restarts EngBook (notes and offline changes are kept). The update banner's Reload now button does the same.

## 0.3.0 — 2026-11-23

### Added
- **Drawing modes:** Freestyle (ink stays as drawn) or Dimensional (every stroke snaps into a clean shape when you lift the pencil, with grid/angle/endpoint snapping; small strokes like letters stay as written). Button on the tool strip and in Settings.
- **Lasso:** select ink, shapes, dimensions and images; drag to move; recolor, duplicate or delete from the selection bar.
- **Partial eraser:** erase only where you rub (tap the eraser's ALL/PART button to switch).
- **Images:** Insert image… from the page menu (photos are resized to keep pages light). Works offline; uploads when back online.
- **PDF import:** Import PDF as pages… from the page, notebook or section menu, or from Home. Each PDF page becomes a page you can write on.
- **Handwriting training:** guided sessions (lowercase, uppercase, digits, engineering symbols), My letters sheet with a consistency score per character, and Practice drills that trace over your own best version and score you. Samples are stored on your server.
- **Update notice** when the server runs a newer version than the open app.
- **Bundled IBM Plex fonts** so every device and printout looks the same.
- **SCALE** box in the title block, filled from the page's drawing scale.

### Changed
- Solid status bar on iPad/iPhone home-screen app (no translucent blur over the top of the app).
- Canvas lines up exactly with screen pixels for sharper ink and grids.
- The tool strip never covers the page: fitted pages leave room for it, and it can be collapsed to just the active tools.

## 0.2.1 — 2026-11-23

### Added
- Loading screen: a bracket drafts itself on a blueprint grid (outline traced by a pencil, then holes, centerlines, dimensions and a title block). Pure SVG and CSS inside the page, so there's no extra download or script, and it respects Reduce Motion.
- Version number next to the EngBook logo in the top bar (also shown on phones) and on the loading screen.

## 0.2.0 — 2026-11-23

### Added
- **Shape snap:** draw a shape and hold the pencil still for half a second. Lines, arcs, polylines, triangles, rectangles (square or rotated), polygons, circles and ellipses become clean shapes. The original stroke is kept.
- After a line snaps, keep moving the pencil to steer its end; a live label shows length and angle.
- **Snapping:** to grid points (graph, dot, isometric, calc pad, lined rows), to 15° angle steps, and to ends, corners, midpoints and centers of other shapes. Snap button on the tool strip; options in Settings.
- **Dimensions:** dimension tool on the tool strip. Tap a line (length), rectangle (width and height), polygon edge, circle (diameter), arc (radius) or ellipse, or drag between any two points. Arrowheads, extension lines and values in inches, millimeters or feet-inches.
- **Drawing scale** per page (1:1 to 1:100, 2:1, 4:1, and 1", 1/2", 1/4", 1/8" = 1'-0"). Dimensions update when the scale or units change.
- **Page numbers:** "3 / 12" at the bottom of each page (can be turned off), SHEET filled in automatically on title blocks, PAGE on calc pads, and page numbers in the library.
- Dimensions are included in PDF, PNG and SVG exports.

### Fixed
- The grid no longer shows through the title block or calc pad header.
- Calc pad header now fits the page width.
- Ink stays on the paper: strokes can't start off the page and are clipped at its edge.
- Pinch-to-zoom on a phone works while drawing with a finger.
- The tool strip no longer shows on the Home screen.
- "null" text no longer appears in the page style settings.

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
