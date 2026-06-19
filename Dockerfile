FROM node:22-alpine

# Create non-root user for security
RUN addgroup -S swiftdrop && adduser -S swiftdrop -G swiftdrop

WORKDIR /app

# Copy app files (zero npm dependencies — nothing to install)
COPY --chown=swiftdrop:swiftdrop . .

# Create uploads/data directories and hand the whole app dir to swiftdrop,
# since server.js creates these at runtime as the non-root user
RUN mkdir -p uploads data && chown -R swiftdrop:swiftdrop /app

USER swiftdrop

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
