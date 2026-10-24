# syntax=docker/dockerfile:1
# Image produksi Trilogika Invoice. Tiga target:
#   runner (default) — aplikasi saja (Next.js standalone, tanpa devDependencies)
#   tools            — migrasi / seed / backup / rekonsiliasi (memuat Prisma CLI & tsx)
# Dasar Debian (bukan Alpine) agar engine Prisma (openssl-3.0.x) kompatibel.

FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Alat operasional ──
FROM build AS tools
ENV NODE_ENV=production
CMD ["npm", "run", "db:migrate"]

# ── Aplikasi ──
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN useradd --system --uid 1001 --gid root app
COPY --from=build --chown=app:root /app/.next/standalone ./
COPY --from=build --chown=app:root /app/.next/static ./.next/static
COPY --from=build --chown=app:root /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
