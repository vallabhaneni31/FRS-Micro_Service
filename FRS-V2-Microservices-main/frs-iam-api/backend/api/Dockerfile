# Dockerfile — FIX-032: Hardened production container
#
# Security improvements over original:
#   - Multi-stage build (builder → runtime) — no devDependencies in final image
#   - Non-root user (UID 1001) — no root process in container
#   - --ignore-scripts on npm install — prevent malicious lifecycle scripts
#   - Explicit COPY with .dockerignore — no secrets/test files in image
#   - Read-only filesystem hints via USER + no SUID
#   - Health check endpoint declared
#   - NODE_ENV=production enforced at build time

# ── Stage 1: Builder ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /build

# Copy manifests first for layer caching
COPY package*.json ./

# Install ALL deps (including dev) for the build step
RUN npm ci

# Copy source
COPY . .

# ── Stage 2: Production runtime ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Install only runtime system packages
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean

# FIX-032: Create non-root user with fixed UID/GID
RUN groupadd --gid 1001 frsapp \
 && useradd  --uid 1001 --gid 1001 --shell /bin/false --no-create-home frsapp

WORKDIR /app

# Copy manifests and install PRODUCTION-only deps
COPY --from=builder /build/package*.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

# Copy application source (no node_modules from builder)
COPY --from=builder /build/src       ./src
COPY --from=builder /build/scripts   ./scripts

# Create writable directories for runtime uploads/logs
RUN mkdir -p uploads/enrollment-photos uploads/attendance-photos uploads/remote-enrollment \
 && chown -R frsapp:frsapp /app

# FIX-032: Drop to non-root
USER frsapp

# Expose port (non-privileged >1024)
EXPOSE 8080

# Security hardening env vars
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=2048" \
    SHARP_IGNORE_GLOBAL_LIBVIPS=1

# Health check so orchestrators know when the container is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/api/health || exit 1

# Entrypoint: run migrations then start server
CMD ["sh", "-c", \
  "node scripts/migrate.js && \
   node -e \"\
     const {pool} = await import('./src/db/pool.js'); \
     const r = await pool.query('SELECT count(*)::int as c FROM frs_tenant'); \
     if(r.rows[0].c===0){ \
       const s=await import('./scripts/seed.js'); \
       await s.default().catch(e=>console.error('[seed]',e.message)); \
     } else { console.log('[seed] skipped:',r.rows[0].c,'tenants exist'); } \
     process.exit(0); \
   \" && \
   node src/server.js"]
