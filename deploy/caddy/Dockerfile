# Caddy with the Cloudflare DNS plugin (for CADDY_TLS=cloudflare).
FROM caddy:2.11.7-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.11.7
COPY --from=build /usr/bin/caddy /usr/bin/caddy
