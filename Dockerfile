# PassIt — multi-stage image. Pure JS/TS, no native dependencies, so
# node:22-alpine needs no build toolchain (pdfkit ships pure JS fonts).

# ─── build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Deps first so the layer caches until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

# tsconfig.json emits src/ -> dist/ (see "build": "tsc -p tsconfig.json").
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── production ──────────────────────────────────────────────────────
FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies only — no typescript, tsx or @types in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output only. The profile picture is embedded in src/brand.ts,
# so brand/passit-pfp.png is not needed at runtime.
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 8402

# Honours PORT when it is overridden; 8402 is the default in src/config.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8402}/health" > /dev/null || exit 1

CMD ["node", "dist/index.js"]
