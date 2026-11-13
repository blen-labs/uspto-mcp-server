# syntax=docker/dockerfile:1.7

# ---- Stage 1: build ---------------------------------------------------------
# isolated-vm 7 ships prebuilt binaries for Node 24/26 (glibc and musl), so no
# compiler toolchain is needed.
FROM node:25-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json ./
COPY src ./src
COPY schema ./schema
COPY web ./web
COPY legal ./legal
RUN pnpm build && pnpm prune --prod

# ---- Deno: the process-isolated sandbox used for multi-user HTTP serving -----
FROM denoland/deno:bin-2.7.14 AS deno

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:25-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app -m -d /home/app app

COPY --from=deno /deno /usr/local/bin/deno

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    USPTO_LOG_LEVEL=info \
    USPTO_SANDBOX=auto \
    DENO_DIR=/home/app/.cache/deno

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/schema ./schema
COPY LICENSE NOTICE ./

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# --http needs real authentication configured (USPTO_AUTH_PROVIDER=accounts, or an OIDC
# provider); without it the server refuses to start rather than serving unauthenticated.
CMD ["node", "dist/bin.js", "--http"]
