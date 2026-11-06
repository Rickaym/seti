FROM node:24-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY ui/package.json ui/
COPY e2e/package.json e2e/

FROM base AS ui
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@seti/ui..."
COPY shared shared
COPY ui ui
RUN pnpm --filter @seti/ui build

FROM base AS bundle
RUN pnpm install --frozen-lockfile --ignore-scripts --filter seti --filter "@seti/server..."
COPY scripts/build-demo.mjs scripts/
COPY shared shared
COPY server server
RUN node scripts/build-demo.mjs

FROM base AS modules
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@seti/server" \
  && cd node_modules/.pnpm/node-pty@*/node_modules/node-pty \
  && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild

FROM node:24-bookworm-slim AS node

FROM postgres:17-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN groupadd --gid 10001 demo && useradd --uid 10001 --gid demo --no-create-home --shell /usr/sbin/nologin demo
WORKDIR /app
COPY --from=modules /src/node_modules node_modules
COPY --from=modules /src/server/package.json server/package.json
COPY --from=modules /src/server/node_modules server/node_modules
COPY --from=bundle /src/server/dist server/dist
COPY --from=ui /src/ui/dist ui/dist
COPY deploy/demo/entrypoint.sh /usr/local/bin/seti-demo
ENV PATH=/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin \
  SETI_DEMO=1 \
  SETI_HOME=/data/seti \
  SETI_HOST=0.0.0.0 \
  SETI_PORT=3016 \
  SETI_DATABASE_URL=postgresql:///seti_demo?host=/data/run
USER 10001:10001
EXPOSE 3016
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3016/api/ping').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/seti-demo"]
