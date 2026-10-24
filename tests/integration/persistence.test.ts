import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, TEST_PASSWORD, type Fixtures } from "../helpers/db";
import { createDraft, getInvoice, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { login } from "@/server/services/auth";
import { validateSession } from "@/server/auth/session";

let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
});

describe("persistensi: data & sesi bertahan saat proses server dimulai ulang", () => {
  it("invoice, pembayaran, audit, dan sesi dibaca kembali oleh koneksi/klien BARU (simulasi restart)", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { downPayment: 1_000_000 }))).id);
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-14", amount: 2_000_000, method: "Transfer", reference: "R1" });
    const session = await login({ email: "finance@test.local", password: TEST_PASSWORD }, { ip: null, userAgent: null });

    // "Restart": semua koneksi lama ditutup; klien baru tanpa state in-memory apa pun.
    await prisma.$disconnect();
    const fresh = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    try {
      const row = await fresh.invoice.findUniqueOrThrow({ where: { number: inv.number! }, include: { items: true, payments: true } });
      expect(row.status).toBe("ISSUED");
      expect(row.totalAmount).toBe(14_000_000n);
      expect(row.paidAmount).toBe(3_000_000n);
      expect(row.items).toHaveLength(1);
      expect(row.payments).toHaveLength(2);
      expect(await fresh.auditLog.count({ where: { entityId: inv.id } })).toBe(3); // create_draft, issue (termasuk DP), payment.record
      expect((await fresh.invoiceNumberSequence.findUniqueOrThrow({ where: { scopeKey: "ALL" } })).nextValue).toBe(435);
    } finally {
      await fresh.$disconnect();
    }
    // Layanan memakai koneksi baru secara otomatis; sesi login (di DB) masih valid, dan nomor melanjutkan urutan.
    expect(await validateSession(session.token)).toMatchObject({ role: "FINANCE" });
    expect((await getInvoice(fx.finance, inv.id)).amounts.paid).toBe(3_000_000);
    const next = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    expect(next.number).toBe("00435");
  });
});
