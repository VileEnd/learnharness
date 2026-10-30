# syntax=docker/dockerfile:1
#
# LearnHarness — browser-only, self-hosted. One image: the Next standalone
# server plus a system Chromium for demo verification. Data and keys live
# on the /data volume (LH_DATA_DIR / LH_AUTH_FILE). No auth in the app:
# run it behind the deploy/ stack (Caddy + oauth2-proxy + Keycloak).
#
# Native binaries (@napi-rs/canvas, @resvg/resvg-js) are traced for the
# build platform, so the payload is built here, on linux, never copied in.

FROM node:26-trixie-slim AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The standalone gates, in CI order: build → offline provider runtime →
# payload curation (refuses leaked data/keys) → boot + GET-only API smoke → image
# processing (photon WASM) resize inside the standalone tree.
RUN npm run build \
	&& node scripts/smoke-provider-runtime.mjs \
	&& node scripts/build-server.mjs \
	&& node scripts/smoke-server.mjs \
	&& node scripts/smoke-image-runtime.mjs

FROM node:26-trixie-slim AS runtime
# Chromium: demo verification (puppeteer-core, CHROME_PATH). Fonts: SVG text
# rendering (resvg loads system fonts) and demo pages.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		chromium ca-certificates fontconfig \
		fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-cjk \
	&& rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	HOSTNAME=0.0.0.0 \
	PORT=3000 \
	CHROME_PATH=/usr/bin/chromium \
	LH_DATA_DIR=/data/data \
	LH_AUTH_FILE=/data/auth.json
WORKDIR /app
COPY --from=build --chown=node:node /src/.next/standalone ./
COPY --chown=node:node scripts/migrate-to-tenants.mjs ./scripts/migrate-to-tenants.mjs
# Prove demo verification works in THIS image: the payload's own puppeteer
# drives the installed Chromium through one interactive page.
COPY scripts/smoke-demo-runtime.mjs /tmp/smoke-demo-runtime.mjs
RUN node /tmp/smoke-demo-runtime.mjs --standalone /app --browser \
	&& rm /tmp/smoke-demo-runtime.mjs \
	&& mkdir -p /data \
	&& chown node:node /data
# Starts as root only to hand /data to the node user (bind mounts arrive
# owned by the host user), then runs the server as node (uid 1000).
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
