# EngBook — self-hosted engineering notebook
# Copyright (c) 2026 Jerod Ulicki
# No npm packages: the server uses only Node's built-in modules (http, node:sqlite, crypto).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    ENGBOOK_DATA_DIR=/data

WORKDIR /app
COPY VERSION ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
