#!/usr/bin/env bash
# Backup PostgreSQL (format custom, terkompresi) + verifikasi bahwa arsip dapat dibaca + retensi.
#   DATABASE_URL=postgresql://… BACKUP_DIR=/var/backups/trilogika BACKUP_KEEP_DAYS=30 npm run db:backup
# Jadwalkan lewat cron, mis. setiap hari 01:30:
#   30 1 * * *  cd /opt/trilogika-invoice && npm run -s db:backup >> /var/log/trilogika-backup.log 2>&1
set -euo pipefail

# Fallback: baca DATABASE_URL dari .env bila belum ada di environment (skrip bash tidak memuat .env otomatis).
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
fi
: "${DATABASE_URL:?DATABASE_URL wajib diisi}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
URL="${DATABASE_URL%%\?*}"   # buang parameter Prisma (?schema=public) — tidak dikenali pg_dump

umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/trilogika_${STAMP}.dump"

echo "[backup] mulai → $OUT"
pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$URL"

# Verifikasi: arsip harus dapat dibaca dan memuat tabel inti.
TABLES="$(pg_restore --list "$OUT" | grep -c 'TABLE DATA' || true)"
if [ "$TABLES" -lt 10 ]; then
  echo "[backup] GAGAL verifikasi: hanya $TABLES tabel data pada arsip" >&2
  rm -f "$OUT"; exit 1
fi
sha256sum "$OUT" > "$OUT.sha256"
echo "[backup] OK — $(du -h "$OUT" | cut -f1), $TABLES tabel data, sha256 tersimpan."

# Retensi
find "$BACKUP_DIR" -name 'trilogika_*.dump*' -type f -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[backup] hapus lama: /' || true
echo "[backup] SELESAI. Salin arsip ke penyimpanan LUAR server (mis. object storage terenkripsi)."
