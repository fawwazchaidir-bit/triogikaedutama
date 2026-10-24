import "server-only";
import { prisma, transaction, type Tx } from "../db";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { formatInvoiceNumber, scopeKeyFor, validateNumberFormat, type NumberReset } from "@/lib/finance/invoice-number";
import { todayIso } from "@/lib/format";
import { env } from "../env";
import { z } from "zod";

/**
 * ═══════════ KEBIJAKAN NOMOR INVOICE ═══════════
 *  • DRAFT tidak memiliki nomor (tampil "DRAFT"). Draft yang dibuang tidak meninggalkan lubang nomor.
 *  • Nomor DIALOKASIKAN di dalam transaksi penerbitan yang sama dengan perubahan status → nomor dan invoice
 *    terbit atau gagal bersama-sama (rollback mengembalikan penghitung; tidak ada nomor "hangus").
 *  • Alokasi memakai `UPDATE … RETURNING` pada satu baris penghitung per scope: Postgres mengunci baris itu
 *    sampai transaksi selesai, sehingga dua penerbitan bersamaan SELALU memperoleh nomor berbeda
 *    (bukan "baca nomor terakhir lalu tambah satu").
 *  • Constraint UNIQUE pada invoices.number adalah pagar terakhir.
 *  • Nomor yang sudah terbit TIDAK pernah dipakai ulang. Invoice batal tetap memegang nomornya (status
 *    CANCELLED + alasan + audit), sehingga urutan nomor selalu dapat dipertanggungjawabkan.
 *  • Lompatan nomor hanya terjadi bila Administrator menaikkan nomor berikutnya secara manual (tercatat di audit).
 *  • Administrator WAJIB mengonfirmasi nomor awal sebelum invoice pertama dapat diterbitkan.
 */

export interface NumberingConfig {
  invoiceNumberFormat: string;
  invoiceNumberPrefix: string;
  invoiceNumberReset: NumberReset;
  invoiceNumberStart: number;
}

/** Alokasikan nomor berikutnya. HARUS dipanggil di dalam transaksi penerbitan. */
export async function allocateInvoiceNumber(tx: Tx, cfg: NumberingConfig, invoiceDate: string) {
  const scopeKey = scopeKeyFor(cfg.invoiceNumberReset, invoiceDate);
  // Buat baris scope bila belum ada (aman bila dua transaksi berlomba: salah satunya no-op).
  await tx.$executeRaw`
    INSERT INTO invoice_number_sequences ("scopeKey", "nextValue", "updatedAt")
    VALUES (${scopeKey}, ${cfg.invoiceNumberStart}, now())
    ON CONFLICT ("scopeKey") DO NOTHING`;
  // Row lock sampai COMMIT: serialisasi antar penerbit pada scope yang sama.
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    UPDATE invoice_number_sequences
       SET "nextValue" = "nextValue" + 1, "updatedAt" = now()
     WHERE "scopeKey" = ${scopeKey}
 RETURNING "nextValue" - 1 AS seq`;
  const seq = Number(rows[0]?.seq);
  if (!Number.isInteger(seq) || seq < 1) throw new Error("Gagal mengalokasikan nomor invoice");
  const number = formatInvoiceNumber({
    format: cfg.invoiceNumberFormat, prefix: cfg.invoiceNumberPrefix, seq, date: invoiceDate,
  });
  return { number, scopeKey, seq };
}

export interface NumberingStatus {
  confirmed: boolean;
  confirmedAt: string | null;
  format: string;
  prefix: string;
  reset: NumberReset;
  start: number;
  currentScopeKey: string;
  nextSeq: number;
  nextNumber: string;
  lastIssuedNumber: string | null;
  issuedInScope: number;
  /** Nomor berikutnya sudah dipakai invoice lain (konflik konfigurasi). */
  collision: boolean;
}

export async function getNumberingStatus(actor: Actor): Promise<NumberingStatus> {
  assertCan(actor, "settings:view");
  const s = await prisma.companySettings.findUniqueOrThrow({ where: { id: 1 } });
  const today = todayIso(env().APP_TIMEZONE);
  const scopeKey = scopeKeyFor(s.invoiceNumberReset, today);
  const seqRow = await prisma.invoiceNumberSequence.findUnique({ where: { scopeKey } });
  const nextSeq = seqRow?.nextValue ?? s.invoiceNumberStart;
  const nextNumber = formatInvoiceNumber({ format: s.invoiceNumberFormat, prefix: s.invoiceNumberPrefix, seq: nextSeq, date: today });
  const [last, issuedInScope, clash] = await Promise.all([
    prisma.invoice.findFirst({ where: { number: { not: null } }, orderBy: [{ issuedAt: "desc" }], select: { number: true } }),
    prisma.invoice.count({ where: { numberScope: scopeKey } }),
    prisma.invoice.findUnique({ where: { number: nextNumber }, select: { id: true } }),
  ]);
  return {
    confirmed: !!s.invoiceNumberConfirmedAt,
    confirmedAt: s.invoiceNumberConfirmedAt?.toISOString() ?? null,
    format: s.invoiceNumberFormat,
    prefix: s.invoiceNumberPrefix,
    reset: s.invoiceNumberReset,
    start: s.invoiceNumberStart,
    currentScopeKey: scopeKey,
    nextSeq,
    nextNumber,
    lastIssuedNumber: last?.number ?? null,
    issuedInScope,
    collision: !!clash,
  };
}

export const numberingConfigSchema = z.object({
  invoiceNumberFormat: z.string().trim().min(1).max(60),
  invoiceNumberPrefix: z.string().trim().max(20).default(""),
  invoiceNumberReset: z.enum(["NEVER", "YEARLY", "MONTHLY"]),
  invoiceNumberStart: z.number().int().min(1).max(999_999_999),
});

/** Ubah format/awalan/reset. Menolak konfigurasi yang akan menghasilkan nomor yang sudah dipakai. */
export async function updateNumberingConfig(actor: Actor, raw: unknown) {
  assertCan(actor, "numbering:manage");
  const input = parseInput(numberingConfigSchema, raw);
  const check = validateNumberFormat(input.invoiceNumberFormat, input.invoiceNumberPrefix);
  if (!check.ok) throw Errors.validation(check.error ?? "Format nomor tidak valid", { invoiceNumberFormat: check.error ?? "" });

  return transaction(async (tx) => {
    const before = await tx.companySettings.findUniqueOrThrow({ where: { id: 1 } });
    const today = todayIso(env().APP_TIMEZONE);
    const scopeKey = scopeKeyFor(input.invoiceNumberReset, today);
    const seqRow = await tx.invoiceNumberSequence.findUnique({ where: { scopeKey } });
    const nextSeq = seqRow?.nextValue ?? input.invoiceNumberStart;
    const nextNumber = formatInvoiceNumber({ format: input.invoiceNumberFormat, prefix: input.invoiceNumberPrefix, seq: nextSeq, date: today });
    if (await tx.invoice.findUnique({ where: { number: nextNumber }, select: { id: true } })) {
      throw Errors.conflict(
        `Dengan konfigurasi ini nomor berikutnya adalah ${nextNumber}, yang SUDAH dipakai invoice lain. Ubah format atau nomor awal.`,
      );
    }
    const after = await tx.companySettings.update({ where: { id: 1 }, data: input });
    await writeAudit(tx, actor, {
      action: "settings.numbering_config", entityType: "CompanySettings", entityId: "1",
      summary: `Konfigurasi penomoran diubah; nomor berikutnya: ${nextNumber}`,
      before: pick(before), after: pick(after),
    });
    return { nextNumber };
  });
}

const pick = (s: NumberingConfig) => ({
  invoiceNumberFormat: s.invoiceNumberFormat, invoiceNumberPrefix: s.invoiceNumberPrefix,
  invoiceNumberReset: s.invoiceNumberReset, invoiceNumberStart: s.invoiceNumberStart,
});

export const confirmNumberingSchema = z.object({
  nextNumber: z.number().int().min(1).max(999_999_999),
  /** Administrator menyatakan telah memeriksa bahwa nomor ini belum pernah dipakai di dokumen manapun. */
  acknowledgeUnused: z.literal(true, { error: "Anda harus memastikan nomor ini belum pernah dipakai" }),
});

/**
 * Aktivasi penomoran: Administrator menetapkan nomor berikutnya berdasarkan histori perusahaan dan menyatakan
 * nomor itu belum pernah dipakai. Tanpa langkah ini, penerbitan invoice ditolak.
 */
export async function confirmNumbering(actor: Actor, raw: unknown) {
  assertCan(actor, "numbering:manage");
  const input = parseInput(confirmNumberingSchema, raw);
  return transaction(async (tx) => {
    const s = await tx.companySettings.findUniqueOrThrow({ where: { id: 1 } });
    const today = todayIso(env().APP_TIMEZONE);
    const scopeKey = scopeKeyFor(s.invoiceNumberReset, today);
    const number = formatInvoiceNumber({ format: s.invoiceNumberFormat, prefix: s.invoiceNumberPrefix, seq: input.nextNumber, date: today });
    if (await tx.invoice.findUnique({ where: { number }, select: { id: true } })) {
      throw Errors.conflict(`Nomor ${number} sudah dipakai invoice di sistem ini.`);
    }
    const issued = await tx.invoice.count({ where: { numberScope: scopeKey } });
    if (issued === 0) {
      await tx.invoiceNumberSequence.upsert({
        where: { scopeKey },
        create: { scopeKey, nextValue: input.nextNumber },
        update: { nextValue: input.nextNumber },
      });
    }
    await tx.companySettings.update({
      where: { id: 1 },
      data: {
        invoiceNumberConfirmedAt: new Date(),
        invoiceNumberConfirmedById: actor.userId,
        ...(s.invoiceNumberReset === "NEVER" ? { invoiceNumberStart: input.nextNumber } : {}),
      },
    });
    await writeAudit(tx, actor, {
      action: "settings.numbering_confirm", entityType: "CompanySettings", entityId: "1",
      summary: `Nomor awal dikonfirmasi: ${number}`, after: { nextNumber: input.nextNumber, scopeKey, number },
    });
    return { nextNumber: number };
  });
}

export const setNextNumberSchema = z.object({
  nextNumber: z.number().int().min(1).max(999_999_999),
  reason: z.string().trim().min(5, "Alasan wajib diisi (minimal 5 karakter)").max(300),
});

/** Naikkan nomor berikutnya secara manual (mis. setelah mengimpor invoice lama). Tidak boleh mundur. */
export async function setNextNumber(actor: Actor, raw: unknown) {
  assertCan(actor, "numbering:manage");
  const input = parseInput(setNextNumberSchema, raw);
  return transaction(async (tx) => {
    const s = await tx.companySettings.findUniqueOrThrow({ where: { id: 1 } });
    if (!s.invoiceNumberConfirmedAt) throw Errors.conflict("Konfirmasi nomor awal terlebih dahulu.");
    const today = todayIso(env().APP_TIMEZONE);
    const scopeKey = scopeKeyFor(s.invoiceNumberReset, today);
    // Kunci baris penghitung agar tidak berlomba dengan penerbitan yang sedang berjalan.
    await tx.$executeRaw`
      INSERT INTO invoice_number_sequences ("scopeKey", "nextValue", "updatedAt")
      VALUES (${scopeKey}, ${s.invoiceNumberStart}, now()) ON CONFLICT ("scopeKey") DO NOTHING`;
    const [row] = await tx.$queryRaw<{ nextValue: number }[]>`
      SELECT "nextValue" FROM invoice_number_sequences WHERE "scopeKey" = ${scopeKey} FOR UPDATE`;
    const current = Number(row?.nextValue ?? s.invoiceNumberStart);
    if (input.nextNumber < current) {
      throw Errors.conflict("Nomor berikutnya tidak boleh lebih kecil dari penghitung saat ini (nomor tidak boleh dipakai ulang).");
    }
    const number = formatInvoiceNumber({ format: s.invoiceNumberFormat, prefix: s.invoiceNumberPrefix, seq: input.nextNumber, date: today });
    if (await tx.invoice.findUnique({ where: { number }, select: { id: true } })) {
      throw Errors.conflict(`Nomor ${number} sudah dipakai invoice lain.`);
    }
    await tx.invoiceNumberSequence.update({ where: { scopeKey }, data: { nextValue: input.nextNumber } });
    await writeAudit(tx, actor, {
      action: "settings.numbering_set_next", entityType: "InvoiceNumberSequence", entityId: scopeKey,
      summary: `Nomor berikutnya diubah ${current} → ${input.nextNumber}`,
      before: { nextValue: current }, after: { nextValue: input.nextNumber }, reason: input.reason,
    });
    return { nextNumber: number };
  });
}
