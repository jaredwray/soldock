# The local development image of Asterra (tools/docker/README.md). It runs `wrangler dev`, which
# simulates D1, R2, Queues, Durable Objects and Email Service in workerd. It is not a deployment of
# Asterra: Asterra runs only on Cloudflare (docs/self-hosting.md).
#
# Build from the repository root:
#   docker build --file tools/docker/Dockerfile --tag asterra:local .

# Debian, because workerd needs glibc and does not run on Alpine. The digest is the index digest.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
ENV WRANGLER_SEND_METRICS=false
RUN mkdir /app /data && chown node:node /app /data
WORKDIR /app

FROM base AS build
# Corepack installs the pnpm version that the packageManager field of package.json pins.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=node:node apps/dock/package.json apps/dock/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/contracts/package.json packages/contracts/
# Prepare pnpm as root. The node user can then run it.
RUN corepack enable pnpm && corepack prepare --activate
USER node
# The same install as deploy-development.yaml: the dock Worker, the SPA and the workspace packages that
# they use. pnpm-workspace.yaml applies its policies here too. No secret goes into this stage.
RUN pnpm install --frozen-lockfile --filter "@asterra/dock..." --filter "@asterra/web..."
COPY --chown=node:node packages/contracts packages/contracts
COPY --chown=node:node apps/web apps/web
COPY --chown=node:node apps/dock apps/dock
# The SPA CSS refers to these two marks. The path is docs/brand, from the repository root.
COPY --chown=node:node docs/brand/asterra-modern-for-light.svg docs/brand/asterra-modern-for-dark.svg docs/brand/
# The dock Worker serves apps/web/dist as its static assets.
RUN pnpm build

FROM base
LABEL org.opencontainers.image.title="Asterra (local development)" \
	org.opencontainers.image.description="Asterra in wrangler dev, for local development only. Not a deployment." \
	org.opencontainers.image.source="https://github.com/jaredwray/soldock" \
	org.opencontainers.image.licenses="MIT"
# workerd reads the CA certificates of the system for the outbound HTTPS requests of the Worker.
# The slim image has none.
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/tsconfig.base.json ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages/contracts packages/contracts
COPY --from=build --chown=node:node /app/apps/dock apps/dock
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --chown=node:node tools/docker/entrypoint.sh tools/docker/entrypoint.sh
USER node
# The local state: the simulations of D1, R2, Queues and Durable Objects.
ENV ASTERRA_STATE=/data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/app/tools/docker/entrypoint.sh"]
