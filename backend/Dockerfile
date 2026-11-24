# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
# Install ALL deps (including devDeps — prisma CLI lives here)
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client and compile TypeScript
RUN ./node_modules/.bin/prisma generate
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# Install production deps only
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Copy prisma schema + generated client + CLI (needed for migrate deploy)
COPY prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Non-root user for security
RUN addgroup -S campusbrain && adduser -S campusbrain -G campusbrain
USER campusbrain

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

# Use the local pinned prisma CLI — never npx (which can resolve a newer version)
CMD ["node", "dist/index.js"]
