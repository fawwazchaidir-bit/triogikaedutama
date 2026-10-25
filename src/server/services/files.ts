import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { can } from "@/lib/permissions";

type FileKind = "LOGO" | "STAMP" | "SIGNATURE" | "PAYMENT_PROOF" | "EXPENSE_PROOF";

/** Tipe yang diizinkan, diverifikasi dari MAGIC BYTES (bukan dari ekstensi / Content-Type kiriman klien). SVG sengaja ditolak (risiko XSS). */
const SIGNATURES: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/png", ext: "png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "application/pdf", ext: "pdf", test: (b) => b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d },
];

const ALLOWED: Record<FileKind, string[]> = {
  LOGO: ["image/png", "image/jpeg"],
  STAMP: ["image/png", "image/jpeg"],
  SIGNATURE: ["image/png", "image/jpeg"],
  PAYMENT_PROOF: ["image/png", "image/jpeg", "application/pdf"],
  EXPENSE_PROOF: ["image/png", "image/jpeg", "application/pdf"],
};

export function sniffMime(bytes: Uint8Array): { mime: string; ext: string } | null {
  const hit = SIGNATURES.find((s) => s.test(bytes));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

function safeName(name: string, ext: string): string {
  const base = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
  return `${base}.${ext}`;
}

/** Simpan file terverifikasi. Tidak pernah menimpa: unggahan baru = baris baru (histori dokumen tetap utuh). */
export async function storeFile(
  actor: Actor,
  kind: FileKind,
  input: { name: string; bytes: Uint8Array },
  tx: Pick<typeof prisma, "storedFile"> = prisma,
): Promise<{ id: string; mimeType: string; size: number }> {
  assertCan(actor, kind === "PAYMENT_PROOF" ? "payment:record" : kind === "EXPENSE_PROOF" ? "expense:record" : "settings:manage");
  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
  if (input.bytes.byteLength === 0) throw Errors.validation("File kosong.");
  if (input.bytes.byteLength > maxBytes) throw Errors.validation(`Ukuran file maksimal ${env().MAX_UPLOAD_MB} MB.`);
  const sniffed = sniffMime(input.bytes);
  if (!sniffed || !ALLOWED[kind].includes(sniffed.mime)) {
    const allowed = ALLOWED[kind].map((m) => m.split("/")[1]?.toUpperCase()).join(", ");
    throw Errors.validation(`Jenis file tidak diizinkan. Gunakan: ${allowed}.`);
  }
  const buf = Buffer.from(input.bytes);
  const file = await tx.storedFile.create({
    data: {
      kind,
      originalName: safeName(input.name, sniffed.ext),
      mimeType: sniffed.mime,
      size: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
      data: buf,
      uploadedById: actor.userId,
    },
    select: { id: true, mimeType: true, size: true },
  });
  return file;
}

/** Baca file untuk ditampilkan; izin bergantung pada jenis file. */
export async function readFileForActor(actor: Actor, id: string) {
  const file = await prisma.storedFile.findUnique({ where: { id } });
  if (!file) throw Errors.notFound("File");
  const ok =
    file.kind === "LOGO" ||
    (file.kind === "PAYMENT_PROOF" && can(actor.role, "payment:view")) ||
    // Bukti pengeluaran: penyetuju/Finance melihat semua; pencatat hanya bukti yang ia unggah sendiri.
    (file.kind === "EXPENSE_PROOF" && (can(actor.role, "finance:view") || (can(actor.role, "expense:view_own") && file.uploadedById === actor.userId))) ||
    ((file.kind === "STAMP" || file.kind === "SIGNATURE") && (can(actor.role, "settings:view") || can(actor.role, "invoice:pdf")));
  if (!ok) throw Errors.forbidden();
  if (file.kind === "PAYMENT_PROOF" || file.kind === "EXPENSE_PROOF") {
    await writeAudit(prisma, actor, { action: "file.view", entityType: "StoredFile", entityId: id, summary: file.kind === "PAYMENT_PROOF" ? "Bukti pembayaran dibuka" : "Bukti pengeluaran dibuka" });
  }
  return file;
}

/** Baca untuk generator PDF (di server, tanpa pemeriksaan izin tampilan; pemanggil sudah mengotorisasi dokumen). */
export async function readFileBytes(id: string | null | undefined): Promise<{ data: Buffer; mimeType: string } | null> {
  if (!id) return null;
  const f = await prisma.storedFile.findUnique({ where: { id }, select: { data: true, mimeType: true } });
  return f ? { data: Buffer.from(f.data), mimeType: f.mimeType } : null;
}
