# EngBook

A self-hosted engineering notebook. Built for iPad Pro with Apple Pencil, and it also works on a phone or laptop. It runs as one small Docker container.

- Handwriting that feels like paper, with pressure-sensitive pens, an eraser, colors and undo.
- Engineering page styles at true printed scale: graph, isometric, polar, semi-log, calc pad, and a title block.
- Handwriting cleanup that keeps your own hand: it smooths shaky lines and levels slanted words, and the original strokes are always kept.
- Notebooks → sections → sub-sections → pages.
- Saves every stroke automatically, works offline, and syncs live between devices.
- Sign in with a passkey (Face ID) or a password plus an authenticator code.

Version **0.4.0** · © 2026 Jerod Ulicki

---

## Install

### Docker Compose / TrueNAS custom app

```yaml
services:
  engbook:
    image: ghcr.io/leonidis2013/engbook:latest
    pull_policy: always   # download the newest image every time the app starts
    container_name: engbook
    restart: unless-stopped
    ports:
      - "8091:8080"
    environment:
      - TZ=America/Chicago
    volumes:
      - engbook-data:/data

volumes:
  engbook-data:
```

All data (one SQLite database) lives in the `engbook-data` named volume.

**Updating:** with `pull_policy: always`, just **Stop** then **Start** the app in TrueNAS (or Edit → Save). It downloads the newest image each time. Then use **Settings → Data → Reload app** on each device.

The image is built by GitHub Actions on every push to `main`. If the package is private, either make it public under *GitHub → Packages → engbook → Package settings*, or sign in to `ghcr.io` on the server. You can also build it locally by replacing `image:` with `build: .`.

### First run

1. Start the container and look at its log. It prints a one-time **setup code**:
   ```
   docker logs engbook
   [engbook] First run. Setup code: 9CC16B2E
   ```
2. Open EngBook in a browser, enter the setup code, and choose a password.
3. Add the authenticator. On iPad or iPhone, tap **Add to Passwords / authenticator**, then type the 6-digit code it shows.
4. Save your 8 **recovery codes**. Each one works once in place of an authenticator code.
5. Add a passkey so you can sign in with Face ID.

The setup code stops anyone else from claiming a new install on a public address. It's only needed once.

### Put it behind nginx (HTTPS)

Passkeys and offline mode need HTTPS on a real domain name. Example for your nginx proxy:

```nginx
server {
  listen 443 ssl http2;
  server_name engbook.example.com;
  # ssl_certificate ... ;

  client_max_body_size 25m;

  location / {
    proxy_pass http://TRUENAS_IP:8091;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # live sync stream: no buffering, long timeout
  location /api/events {
    proxy_pass http://TRUENAS_IP:8091;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

If the proxy can't send those headers, set `ENGBOOK_ORIGIN=https://engbook.example.com` on the container.

### Install on the iPad

Open the site in Safari → **Share** → **Add to Home Screen**. EngBook then opens full screen like an app and keeps working offline.

---

## Using it

### Apple Pencil and fingers

| Action | How |
|---|---|
| Write / draw | Apple Pencil (pressure and speed shape the line) |
| Pan | One finger (on a phone: in move mode) — with momentum |
| Zoom to a spot / back to fit | Double-tap |
| Zoom | Pinch with two fingers |
| Undo / Redo | Two-finger tap / three-finger tap |
| Tool wheel | Long-press with a finger anywhere on the page |
| Quick erase | Hold the eraser button on the tool strip while you write; let go to go back |
| Eraser on/off | Tap the eraser button |
| Laptop | Mouse draws, scroll pans, Ctrl/⌘ + scroll zooms, Ctrl/⌘+Z undo, Space + drag pans, keys 1–5 pick pens, E eraser, 0 fit page |

Your palm is ignored while the Pencil is writing. On a phone, the first button on the tool strip switches between **move** (hand, one finger scrolls) and **draw** (pen, one finger draws, two fingers move and zoom). Picking a pen switches to draw. You can change this in **Settings → Preferences → Finger drawing**. The tool strip can sit on the left or right.

Safari doesn't give web apps access to Pencil double-tap, squeeze, hover or haptics, so EngBook uses the finger controls above instead.

### Pens and colors

There are five pen presets: fine-liner, technical pen (fixed width), pencil, red-line pen and highlighter. The highlighter always sits under the ink. Choosing a color or line weight changes the selected preset.

- Line weights are 0.25, 0.35, 0.5, 0.7 and 1.0 mm. Highlighters are 3, 5 and 8 mm.
- The engineering palette is black, blue, red, green, amber and gray, plus custom colors and recent colors.
- **Colors on this page** (in the color panel) lets you show or hide ink by color.
- **Color legend** (notebook menu) lets you name what each color means, such as red = revision.
- On blueprint and dark pages, black ink turns white and the other colors adjust to stay readable.

### Drawing modes, lasso and eraser

- **Freestyle / Dimensional** (tool strip button, or Settings): in Dimensional mode every stroke becomes a clean, snapped shape when you lift the pencil. Small strokes such as letters stay as written. In Freestyle, hold the pencil still at the end of a stroke to snap just that one.
- **Lasso:** circle what you want, then drag inside the box to move it. The selection bar recolors, duplicates or deletes.
- **Eraser:** tap the ALL / PART button under the color to switch between removing whole strokes and erasing only where you rub.
- **Collapse the tool strip** with the arrow at its top; only the tools in use stay visible.

### Images and PDFs

- **Insert image…** (page menu) places a photo on the page; move it with the lasso.
- **Import PDF as pages…** (page, notebook or section menu, or Home) turns each PDF page into an EngBook page you can write on. Good for Apple Notes exports, datasheets and manuals.

### Handwriting training

Open it from **Home** or **Settings → Preferences**.

1. **Guided session:** write each character three times (lowercase, uppercase, digits, engineering symbols).
2. **My letters:** your most typical version of each character with a consistency score.
3. **Practice:** your least consistent characters, with your own best version as a faint guide to trace; scores of 70+ are saved as new samples.

### Snap and dimensions

- **Snap a shape:** draw it, then hold the pencil still for half a second. EngBook turns it into a clean line, arc, polyline, triangle, rectangle, polygon, circle or ellipse. After a line snaps, keep moving to steer its end; a label shows its length and angle.
- **What it snaps to:** grid points, 15° angles, and the ends, corners, midpoints and centers of other shapes. Turn snapping on or off with the magnet button; pick which snaps you want in **Settings → Preferences**. Handwriting is never snapped.
- **Dimensions:** pick the dimension tool (↔) on the tool strip. Tap a line, rectangle, polygon edge, circle, arc or ellipse, or drag between two points. The dimension sits on the left side of the direction you drag.
- **Drawing scale:** set per page in **Page style** (1:1 to 1:100, 2:1, 4:1, 1" = 1'-0" and other architectural scales). Dimensions follow the page scale and your inch / mm setting.

### Page styles

| Style | Options |
|---|---|
| Blank | |
| Lined | narrow / college / wide, margin line |
| Engineering graph | 4, 5 or 10 squares per inch, or 5 mm, with bold major lines |
| Isometric | triangle grid or dots, 5 mm |
| Dot grid | 5 mm |
| Polar | 10 mm rings, 15° rays, degree labels |
| Semi-log | 1–4 decades |
| Calc pad | 5 mm grid with Project / Subject / By / Date header |
| Title block | border plus Project / Rev / Title / Date / Drawn by / Sheet, on any style |

The page sizes are Letter, Tabloid and endless canvas, in portrait or landscape. Pages are numbered within their notebook ("3 / 12" at the bottom, or in the title block's SHEET box). The page tone can be white paper, blueprint or dark. You can change a page's style at any time and the ink stays where it is. Notebooks and sections can each have a default style for new pages.

### Handwriting cleanup (v0.4)

Choose **Uppercase engineering** (default) or **Everyday handwriting** lettering in Settings. Uppercase gets crisp straight strokes, upright letters, even heights and a level baseline; everyday keeps your own slant (learned in training), just steadier. **Align writing to rows and grid lines** sits each word on the nearest ruled line or grid line.

### Handwriting cleanup (details)

On by default. You can change it in **Settings → Preferences**.

1. **Smooth.** Removes hand jitter and the little hooks where the Pencil lands or lifts, and keeps sharp corners.
2. **Straighten.** About a second after you finish a word, EngBook levels its baseline if it's tilted (1°–12°).

Your original strokes are always kept. **Page menu → Compare original handwriting** shows them.

### Export and print

- **Print / Save as PDF** prints at true size. Choose "Save as PDF" in the print dialog to get a vector PDF.
- **Notebook menu → Print / Save as PDF** puts every page of a notebook into one PDF.
- You can also export a PNG, an SVG, or the ink only as SVG.
- **Settings → Data → Print test ruler** prints a page for checking that your printer is set to 100%.
- **Settings → Data → Download full export** saves everything as one JSON file.

---

## Security

- Sign-in uses a passkey (Face ID) or a password with an authenticator code. Losing the authenticator is covered by 8 one-time recovery codes.
- Passwords are hashed with scrypt.
- Authenticator codes can't be used twice.
- After 5 failed sign-ins from one address, or 20 in total, sign-in locks for 15 minutes.
- Every sign-in is logged, and the log is shown in **Settings → Sign-in & security**.
- Session cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` over HTTPS. Every API change also needs an `X-EngBook` header, which blocks cross-site requests.
- Strict Content-Security-Policy, no third-party scripts, no telemetry.

**Locked out?** Start the container once with `ENGBOOK_RESET_AUTH=1`. That clears the password, authenticator, passkeys and sessions but keeps your notes. Remove the variable, restart, and run setup again with the new setup code from the log.

## Backups

Everything is in the `engbook-data` volume (`/data/engbook.db`). Snapshot it with TrueNAS, or copy it out:

```sh
docker run --rm -v engbook-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/engbook-$(date +%F).tgz -C /data .
```

**Settings → Data → Download full export** gives you a portable JSON copy as well.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port inside the container |
| `ENGBOOK_DATA_DIR` | `/data` | Where the database lives |
| `ENGBOOK_ORIGIN` | from proxy headers | Public URL, e.g. `https://engbook.example.com` (passkeys) |
| `ENGBOOK_RP_ID` | host of the origin | Passkey domain, if it should differ |
| `ENGBOOK_TRUST_PROXY` | `1` | Trust `X-Forwarded-*` headers from your proxy (set `0` if exposed directly) |
| `ENGBOOK_SETUP_CODE` | random | Fix the first-run setup code |
| `ENGBOOK_RESET_AUTH` | — | `1` = reset sign-in on start (keeps notes) |

## How it's built

- **Server:** Node 22, built-in modules only (`http`, `node:sqlite`, `crypto`), so there's no `npm install` and nothing to keep patched besides Node itself. The server also handles WebAuthn (passkeys) and the authenticator codes itself.
- **Client:** plain JavaScript modules and canvas, with no build step. Ink is stored as vector points (x, y, pressure, time) and drawn as pressure-shaped outlines.
- **Sync:** every change is saved on the device first (IndexedDB), sent from an outbox in order, and shared with other devices over Server-Sent Events. Strokes are only ever added or deleted, so changes from two offline devices merge without losing ink.

## Roadmap

- **0.4:** read-only share links, page version history, handwriting search, learned handwriting cleanup, layers.
- **1.1:** shape snap, dimensions, ruler / protractor / compass, symbol libraries (audio, electrical, network, PLC / P&ID), calc blocks with units, revision clouds.
- **2.0:** learned handwriting cleanup, handwriting search, handwritten math to typeset, Claude MCP access, Paperless archive.

## License

© 2026 Jerod Ulicki. All rights reserved.
