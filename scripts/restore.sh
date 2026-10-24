#!/usr/bin/env bash
# Pemulihan dari arsip backup. AMAN SECARA DEFAULT: menolak menimpa database yang berisi data.
#   Latihan pemulihan (disarankan rutin): pulihkan ke database KOSONG/baru
#     createdb trilogika_restore_check
#     TARGET_URL=postgresql://…/trilogika_restore_check npm run db:restore -- backups/trilogika_X.dump
#   Pemulihan sebenarnya ke database produksi (berisi data) — HANYA setelah aplikasi dihentikan:
#     CONFIRM_RESTORE=yes TARGET_URL=… npm run db:restore -- backups/trilogika_X.dump
set -euo pipefail

FILE="${1:?Gunakan: npm run db:restore -- <arsip.dump>}"
: "${TARGET_URL:?TARGET_URL (database tujuan) wajib diisi}"
URL="${TARGET_URL%%\?*}"
[ -f "$FILE" ] || { echo "Arsip tidak ditemukan: $FILE" >&2; exit 1; }

if [ -f "$FILE.sha256" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256") || { echo "Checksum arsip TIDAK cocok — dibatalkan." >&2; exit 1; }
fi

EXISTING="$(psql "$URL" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)"
if [ "$EXISTING" -gt 0 ] && [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "Database tujuan sudah berisi $EXISTING tabel. Untuk MENIMPA set CONFIRM_RESTORE=yes (pastikan aplikasi berhenti & Anda punya backup terbaru)." >&2
  exit 1
fi

echo "[restore] memulihkan $FILE → ${URL##*/}"
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction -d "$URL" "$FILE"
echo "[restore] selesai. Jalankan: DATABASE_URL='$TARGET_URL' npm run db:reconcile"
