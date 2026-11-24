# EngBook — self-hosted engineering notebook
# Copyright (c) 2026 Jerod Ulicki
# The server uses only Node's built-in modules. A build stage adds two static files sets:
# IBM Plex fonts (SIL Open Font License) and pdf.js (Apache 2.0) for PDF import.

# ---- static extras, fetched while the image is built ----
FROM node:22-alpine AS vendor
WORKDIR /v
RUN mkdir -p /out/vendor/pdfjs /out/fonts; \
    ( mkdir pdf && cd pdf && npm pack pdfjs-dist@4 --silent >/dev/null && tar xzf pdfjs-dist-*.tgz \
      && cp package/build/pdf.min.mjs package/build/pdf.worker.min.mjs /out/vendor/pdfjs/ \
      && cp package/LICENSE /out/vendor/pdfjs/LICENSE ) || echo "WARN: pdf.js not bundled"; \
    for p in @ibm/plex-sans @ibm/plex-mono; do \
      d=$(echo $p | tr '/@' '__'); mkdir -p $d; ( cd $d && npm pack $p --silent >/dev/null && tar xzf *.tgz ) || echo "WARN: $p not fetched"; \
    done; \
    if [ -z "$(find . -name 'IBMPlexSans-Regular.woff2' | head -1)" ]; then \
      mkdir -p plex && ( cd plex && npm pack @ibm/plex@6 --silent >/dev/null && tar xzf *.tgz ) || echo "WARN: @ibm/plex not fetched"; fi; \
    for n in IBMPlexSans-Regular IBMPlexSans-Medium IBMPlexSans-SemiBold IBMPlexMono-Regular IBMPlexMono-Medium IBMPlexMono-SemiBold; do \
      f=$(find . -name "$n.woff2" | grep -v -i 'split\|subset' | head -1); \
      [ -n "$f" ] && cp "$f" /out/fonts/ || echo "WARN: font $n not found"; \
    done; \
    lic=$(find . -iname 'LICENSE*' -path '*plex*' | head -1); [ -n "$lic" ] && cp "$lic" /out/fonts/LICENSE.txt; \
    echo "Bundled:"; ls -la /out/vendor/pdfjs /out/fonts

# ---- app ----
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    ENGBOOK_DATA_DIR=/data

WORKDIR /app
COPY VERSION ./
COPY server ./server
COPY public ./public
COPY --from=vendor /out/vendor ./public/vendor
COPY --from=vendor /out/fonts ./public/fonts

RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
