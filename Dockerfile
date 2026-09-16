# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Runs as an unprivileged user. /data is created and owned here so a fresh
# named volume mounted over it (which Docker seeds from the image's existing
# content and ownership) is writable without extra setup; a bind mount from
# the host may still need its permissions matched manually.
RUN apk add --no-cache tini \
  && addgroup -S exporter && adduser -S exporter -G exporter \
  && mkdir -p /data && chown exporter:exporter /data
USER exporter

ENV PORT=9877
ENV DATA_DIR=/data
EXPOSE 9877

# /healthz has no auth, but when WEB_CONFIG_FILE enables TLS it's only
# served over https (same port, same scheme as everything else) — so try
# plain http first and fall back to an unverified https request, rather than
# hardcoding one scheme.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --quiet --tries=1 --spider "http://localhost:${PORT:-9877}/healthz" \
  || wget --quiet --tries=1 --spider --no-check-certificate "https://localhost:${PORT:-9877}/healthz"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
