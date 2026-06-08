# ── Build stage ───────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Production stage ───────────────────────────────────
FROM node:22-alpine

# Create non-root user for security
RUN addgroup -S swiftdrop && adduser -S swiftdrop -G swiftdrop

WORKDIR /app

# Copy app files
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=swiftdrop:swiftdrop . .

# Create uploads directory with correct permissions
RUN mkdir -p uploads && chown swiftdrop:swiftdrop uploads

USER swiftdrop

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
