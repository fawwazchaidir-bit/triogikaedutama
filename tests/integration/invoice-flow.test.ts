import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import {
  cancelInvoice, createDraft, deleteDraft, duplicateInvoice, getInvoice, issueInvoice, listInvoices, updateDraft,
} from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { AppError } from "@/server/errors";

let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
});

const expectAppError = async (p: Promise<unknown>, code: string, msg?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "harus melempar error").toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (msg) expect((err as AppError).message).toMatch(msg);
};

describe("skenario acuan brief — CV Bima Satria Jaya", () => {
  it("draft → terbit: total, terbilang input, saldo, status, nomor 00434, jatuh tempo", async () => {
    const draft = await createDraft(fx.finance, demiChefInput(fx));
    expect(draft.status).toBe("DRAFT");
    expect(draft.number).toBeNull();
    expect(draft.amounts.subtotal).toBe(14_000_000);
    expect(draft.amounts.total).toBe(14_000_000);

    const inv = await issueInvoice(fx.finance, draft.id, { expectedTotalAmount: 14_000_000 });
    expect(inv.status).toBe("ISSUED");
    expect(inv.number).toBe("00434");
    expect(inv.amounts).toMatchObject({ subtotal: 14_000_000, tax: 0, transport: 0, admin: 0, downPayment: 0, total: 14_000_000, paid: 0, balance: 14_000_000 });
    expect(inv.paymentStatus).toBe("UNPAID");
    expect(inv.dueDate).toBe("2026-01-17"); // 13 Jan + 4 hari kalender
    expect(inv.customerFrozen).toBe(true);
    expect(inv.bank).toMatchObject({ label: "MANDIRI-IDR", accountNumber: "137-00-2072139-1" });
    // remark otomatis dari deskripsi baris tunggal
    expect(inv.remark).toBe("Biaya Diklat & Uji Kompetensi Bidang Food Production (Skema Demi Chef)");
  });

  it("nomor berikutnya berurutan 00435, 00436 dan tidak dipakai ulang setelah pembatalan", async () => {
    const nums: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await createDraft(fx.finance, demiChefInput(fx));
      nums.push((await issueInvoice(fx.finance, d.id)).number!);
    }
    expect(nums).toEqual(["00434", "00435", "00436"]);

    const second = await prisma.invoice.findUniqueOrThrow({ where: { number: "00435" } });
    const { invoice } = await cancelInvoice(fx.finance, second.id, { reason: "Salah nama pelanggan" });
    expect(invoice.status).toBe("CANCELLED");
    expect(invoice.number).toBe("00435"); // nomor tetap melekat
    expect(invoice.cancelReason).toBe("Salah nama pelanggan");

    const next = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    expect(next.number).toBe("00437"); // tidak ada daur ulang 00435
  });
});

describe("perhitungan tersimpan konsisten (CHECK constraint DB ikut menguji)", () => {
  it("beberapa item + diskon + pajak + transport + admin + DP", async () => {
    const input = demiChefInput(fx, {
      lines: [
        { productId: fx.productId, description: "Diklat A", quantity: 3, unit: "Pax", unitPrice: 2_000_000, discount: 100_000, taxConfigId: fx.ppnId },
        { productId: null, description: "Konsultasi", quantity: "1.5", unit: "Hari", unitPrice: 1_000_000, discount: 0, taxConfigId: null },
      ],
      extraDiscount: 200_000, transport: 150_000, admin: 50_000, downPayment: 1_000_000,
    });
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, input)).id);
    // subtotal: (6.000.000−100.000) + 1.500.000 = 7.400.000 ; diskon tambahan 200.000 → 7.200.000
    // dasar pajak baris 1 = 5.900.000 − 200.000×(5.9/7.4) = 5.900.000 − 159.459 = 5.740.541 ; pajak 11% = 631.460
    expect(inv.amounts.subtotal).toBe(7_400_000);
    expect(inv.amounts.extraDiscount).toBe(200_000);
    expect(inv.amounts.tax).toBe(631_460);
    expect(inv.amounts.total).toBe(7_400_000 - 200_000 + 631_460 + 200_000);
    expect(inv.amounts.downPayment).toBe(1_000_000);
    expect(inv.amounts.paid).toBe(1_000_000); // DP tercatat sebagai pembayaran
    expect(inv.amounts.balance).toBe(inv.amounts.total - 1_000_000);
    expect(inv.paymentStatus).toBe("PARTIALLY_PAID");
    const payments = await prisma.payment.findMany({ where: { invoiceId: inv.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ isDownPayment: true, entryType: "PAYMENT", amount: 1_000_000n });
  });

  it("server mengabaikan total dari klien dan menghitung ulang (expectedTotal yang salah ditolak)", async () => {
    const d = await createDraft(fx.finance, demiChefInput(fx));
    await expectAppError(issueInvoice(fx.finance, d.id, { expectedTotalAmount: 13_999_999 }), "CONFLICT", /Total berubah/);
    expect((await getInvoice(fx.finance, d.id)).status).toBe("DRAFT");
  });

  it("menolak input tidak valid: qty 0, harga negatif, diskon > baris, DP > total, tanggal ngawur", async () => {
    const bad = (o: Record<string, unknown>) => createDraft(fx.finance, demiChefInput(fx, o));
    const line = (o: Record<string, unknown>) => ({ lines: [{ ...demiChefInput(fx).lines[0], ...o }] });
    await expectAppError(bad(line({ quantity: 0 })), "VALIDATION");
    await expectAppError(bad(line({ quantity: "abc" })), "VALIDATION");
    await expectAppError(bad(line({ unitPrice: -1 })), "VALIDATION");
    await expectAppError(bad(line({ unitPrice: 1.5 })), "VALIDATION");
    await expectAppError(bad(line({ discount: 99_000_000 })), "VALIDATION", /Diskon baris/);
    await expectAppError(bad({ downPayment: 15_000_000 }), "VALIDATION", /Down Payment/);
    await expectAppError(bad({ invoiceDate: "2026-02-31" }), "VALIDATION");
    await expectAppError(bad({ lines: [] }), "VALIDATION");
    expect(await prisma.invoice.count()).toBe(0);
  });
});

describe("snapshot: perubahan master tidak mengubah invoice lama", () => {
  it("harga produk, nama/alamat pelanggan, dan pengaturan perusahaan berubah → invoice terbit tetap", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const before = await getInvoice(fx.finance, inv.id);

    await prisma.product.update({ where: { id: fx.productId }, data: { defaultPrice: 9_999_999n, name: "Nama Baru", schemeName: "Skema Baru" } });
    await prisma.customer.update({ where: { id: fx.customerId }, data: { name: "PT Nama Baru", address: "Alamat Baru", npwp: "99.999" } });
    await prisma.companySettings.update({ where: { id: 1 }, data: { name: "LEMBAGA BARU", address: "Alamat Lembaga Baru", signerName: "Orang Lain" } });
    await prisma.bankAccount.update({ where: { id: fx.bankId }, data: { accountNumber: "000-BARU" } });

    const after = await getInvoice(fx.finance, inv.id);
    expect(after.customerName).toBe("CV Bima Satria Jaya");
    expect(after.customer.address).toBe("Jl. Kaliurang Km 7, Sleman");
    expect(after.bank?.accountNumber).toBe("137-00-2072139-1");
    expect(after.lines[0]).toMatchObject({ unitPrice: 2_000_000, description: before.lines[0]!.description });
    expect(after.amounts).toEqual(before.amounts);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect((row.companySnapshot as { name: string; signerName: string }).name).toBe("TRILOGIKA EDUTAMA");
    expect((row.companySnapshot as { signerName: string }).signerName).toBe("Elva Aditya Fawwaz, S.E.");
  });
});

describe("imutabilitas invoice terbit", () => {
  it("service menolak edit & hapus invoice terbit", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    await expectAppError(updateDraft(fx.finance, inv.id, demiChefInput(fx, { transport: 5 })), "CONFLICT", /sudah diterbitkan/);
    await expectAppError(deleteDraft(fx.finance, inv.id), "CONFLICT", /Hanya draft/);
  });

  it("DB menolak manipulasi langsung (defense in depth)", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    await expect(prisma.$executeRaw`UPDATE invoices SET "totalAmount" = 1, "balanceAmount" = 1 WHERE id = ${inv.id}::uuid`).rejects.toThrow(/sudah terbit/);
    await expect(prisma.$executeRaw`UPDATE invoices SET number = '99999' WHERE id = ${inv.id}::uuid`).rejects.toThrow(/sudah terbit/);
    await expect(prisma.$executeRaw`DELETE FROM invoices WHERE id = ${inv.id}::uuid`).rejects.toThrow(/tidak boleh dihapus/);
    await expect(prisma.$executeRaw`UPDATE invoice_items SET "unitPrice" = 1 WHERE "invoiceId" = ${inv.id}::uuid`).rejects.toThrow(/DRAFT/);
    await expect(prisma.$executeRaw`DELETE FROM invoice_items WHERE "invoiceId" = ${inv.id}::uuid`).rejects.toThrow(/DRAFT/);
    await expect(prisma.$executeRaw`UPDATE invoices SET "totalAmount" = 5 WHERE id = ${inv.id}::uuid`).rejects.toThrow(); // CHECK identitas
    await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'x'`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM audit_logs`).rejects.toThrow(/append-only/);
  });
});

describe("konkurensi & atomisitas penerbitan", () => {
  it("10 penerbitan bersamaan menghasilkan 10 nomor unik berurutan tanpa celah", async () => {
    const drafts = await Promise.all(Array.from({ length: 10 }, () => createDraft(fx.finance, demiChefInput(fx))));
    const results = await Promise.all(drafts.map((d, i) => issueInvoice(i % 2 ? fx.finance : fx.admin, d.id)));
    const numbers = results.map((r) => r.number!).sort();
    expect(new Set(numbers).size).toBe(10);
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => String(434 + i).padStart(5, "0")));
    const seq = await prisma.invoiceNumberSequence.findUniqueOrThrow({ where: { scopeKey: "ALL" } });
    expect(seq.nextValue).toBe(444);
  });

  it("klik ganda / dua pengguna menerbitkan invoice yang sama: hanya satu berhasil, hanya satu nomor terpakai", async () => {
    const d = await createDraft(fx.finance, demiChefInput(fx));
    const settled = await Promise.allSettled([
      issueInvoice(fx.finance, d.id), issueInvoice(fx.finance, d.id), issueInvoice(fx.admin, d.id), issueInvoice(fx.finance, d.id),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect((r.reason as AppError).code).toBe("CONFLICT");
    expect(await prisma.invoice.count({ where: { status: "ISSUED" } })).toBe(1);
    expect(await prisma.invoiceNumberSequence.findUniqueOrThrow({ where: { scopeKey: "ALL" } }).then((s) => s.nextValue)).toBe(435);
  });

  it("error di tengah transaksi me-rollback SEMUA (nomor tidak hangus, draft utuh)", async () => {
    // Simulasi tabrakan nomor: ada invoice lain yang sudah memegang 00434 → UNIQUE melempar di tengah transaksi.
    const other = await createDraft(fx.finance, demiChefInput(fx));
    await prisma.$executeRaw`ALTER TABLE invoices DISABLE TRIGGER invoices_guard`;
    try {
      await prisma.$executeRaw`UPDATE invoices SET status='ISSUED', number='00434', "issuedAt"=now(), "issuedById"=${fx.finance.userId}::uuid WHERE id=${other.id}::uuid`;
    } finally {
      await prisma.$executeRaw`ALTER TABLE invoices ENABLE TRIGGER invoices_guard`;
    }
    const d = await createDraft(fx.finance, demiChefInput(fx, { downPayment: 1_000_000 }));
    await expect(issueInvoice(fx.finance, d.id)).rejects.toThrow();

    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.status).toBe("DRAFT");
    expect(row.number).toBeNull();
    expect(await prisma.payment.count({ where: { invoiceId: d.id } })).toBe(0); // DP tidak tersimpan setengah jalan
    expect((await prisma.invoiceNumberSequence.findUniqueOrThrow({ where: { scopeKey: "ALL" } })).nextValue).toBe(434); // penghitung kembali
  });

  it("penerbitan ditolak bila nomor awal belum dikonfirmasi administrator", async () => {
    await resetDb();
    fx = await seedFixtures({ confirmNumbering: false });
    const d = await createDraft(fx.finance, demiChefInput(fx));
    await expectAppError(issueInvoice(fx.finance, d.id), "CONFLICT", /belum dikonfirmasi/);
    expect(await prisma.invoiceNumberSequence.count()).toBe(0);
  });

  it("pelanggan yang diarsipkan menghalangi penerbitan", async () => {
    const d = await createDraft(fx.finance, demiChefInput(fx));
    await prisma.customer.update({ where: { id: fx.customerId }, data: { isActive: false } });
    await expectAppError(issueInvoice(fx.finance, d.id), "CONFLICT", /diarsipkan/);
  });

  it("dua editor: optimistic locking menolak simpan dengan versi usang", async () => {
    const d = await createDraft(fx.finance, demiChefInput(fx));
    await updateDraft(fx.finance, d.id, demiChefInput(fx, { transport: 10_000, expectedVersion: d.version }));
    await expectAppError(updateDraft(fx.admin, d.id, demiChefInput(fx, { transport: 20_000, expectedVersion: d.version })), "CONFLICT", /diubah oleh pengguna/);
    expect((await getInvoice(fx.finance, d.id)).amounts.transport).toBe(10_000);
  });
});

describe("pembayaran sebagian, pelunasan, pembalikan", () => {
  const pay = (invoiceId: string, amount: number, extra: Record<string, unknown> = {}) =>
    recordPayment(fx.finance, { invoiceId, paymentDate: "2026-01-14", amount, method: "Transfer", reference: "TRX1", ...extra });

  it("Rp5jt lalu Rp9jt → saldo 0 dan status Paid", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    await pay(inv.id, 5_000_000);
    let cur = await getInvoice(fx.finance, inv.id);
    expect(cur.paymentStatus).toBe("PARTIALLY_PAID");
    expect(cur.amounts).toMatchObject({ total: 14_000_000, paid: 5_000_000, balance: 9_000_000 });
    await pay(inv.id, 9_000_000);
    cur = await getInvoice(fx.finance, inv.id);
    expect(cur.paymentStatus).toBe("PAID");
    expect(cur.amounts.balance).toBe(0);
  });

  it("menolak kelebihan bayar, nominal 0, tanggal masa depan, dan invoice draft/batal", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    await expectAppError(pay(inv.id, 14_000_001), "VALIDATION", /melebihi sisa/);
    await expectAppError(pay(inv.id, 0), "VALIDATION");
    await expectAppError(pay(inv.id, 1000, { paymentDate: "2999-01-01" }), "VALIDATION", /masa depan/);
    const draft = await createDraft(fx.finance, demiChefInput(fx));
    await expectAppError(pay(draft.id, 1000), "CONFLICT", /sudah diterbitkan/);
    await pay(inv.id, 14_000_000);
    await expectAppError(pay(inv.id, 1), "CONFLICT", /lunas/);
  });

  it("pembayaran bersamaan tidak boleh melewati sisa tagihan", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => pay(inv.id, 5_000_000)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2); // 5jt + 5jt; sisa 4jt < 5jt
    const cur = await getInvoice(fx.finance, inv.id);
    expect(cur.amounts.paid).toBe(10_000_000);
    expect(cur.amounts.balance).toBe(4_000_000);
  });

  it("pembalikan: histori tetap, saldo kembali, tidak bisa dibalik dua kali", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const p = await pay(inv.id, 14_000_000);
    expect((await getInvoice(fx.finance, inv.id)).paymentStatus).toBe("PAID");
    await expectAppError(reversePayment(fx.finance, p.id, { reason: "x" }), "VALIDATION");
    const rev = await reversePayment(fx.finance, p.id, { reason: "Salah input nominal" });
    expect(rev.amount).toBe(-14_000_000);
    const cur = await getInvoice(fx.finance, inv.id);
    expect(cur.paymentStatus).toBe("UNPAID");
    expect(cur.amounts).toMatchObject({ paid: 0, balance: 14_000_000 });
    expect(await prisma.payment.count({ where: { invoiceId: inv.id } })).toBe(2); // asli + pembalikan
    await expectAppError(reversePayment(fx.finance, p.id, { reason: "Coba lagi" }), "CONFLICT", /sudah pernah/);
    const res = await Promise.allSettled([reversePayment(fx.finance, (await pay(inv.id, 1_000_000)).id, { reason: "paralel 1" }), reversePayment(fx.finance, (await prisma.payment.findFirstOrThrow({ where: { amount: 1_000_000n } })).id, { reason: "paralel 2" })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(prisma.$executeRaw`UPDATE payments SET amount = 1`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM payments`).rejects.toThrow(/append-only/);
  });

  it("cache invoice == Σ ledger setelah rangkaian operasi campuran", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { downPayment: 2_000_000 }))).id);
    const a = await pay(inv.id, 3_000_000);
    await pay(inv.id, 1_000_000);
    await reversePayment(fx.finance, a.id, { reason: "Dana dikembalikan" });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    const sum = await prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
    expect(row.paidAmount).toBe(sum._sum.amount);
    expect(row.balanceAmount).toBe(row.totalAmount - row.paidAmount);
    expect(Number(row.paidAmount)).toBe(3_000_000); // DP 2jt + 1jt
  });
});

describe("pembatalan", () => {
  it("invoice dengan pembayaran tidak bisa dibatalkan sebelum pembayaran dibalikkan", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-14", amount: 1_000_000, method: "Transfer" });
    await expectAppError(cancelInvoice(fx.finance, inv.id, { reason: "Dibatalkan pelanggan" }), "CONFLICT", /pembayaran/);
    await reversePayment(fx.finance, p.id, { reason: "Pelanggan membatalkan" });
    const { invoice } = await cancelInvoice(fx.finance, inv.id, { reason: "Dibatalkan pelanggan" });
    expect(invoice.status).toBe("CANCELLED");
    expect(invoice.amounts.balance).toBe(0);
    expect(await prisma.invoice.count({ where: { id: inv.id } })).toBe(1); // riwayat dipertahankan
    await expectAppError(cancelInvoice(fx.finance, inv.id, { reason: "Dobel batal" }), "CONFLICT", /sudah dibatalkan/);
    await expect(prisma.$executeRaw`UPDATE invoices SET status='ISSUED' WHERE id=${inv.id}::uuid`).rejects.toThrow(/batal/i);
  });

  it("alasan wajib; pembatalan + draft pengganti menautkan invoice", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    await expectAppError(cancelInvoice(fx.finance, inv.id, { reason: "" }), "VALIDATION");
    const { replacementId } = await cancelInvoice(fx.finance, inv.id, { reason: "Salah harga satuan", createReplacement: true });
    expect(replacementId).toBeTruthy();
    const repl = await getInvoice(fx.finance, replacementId!);
    expect(repl.status).toBe("DRAFT");
    expect(repl.number).toBeNull();
    expect(repl.replacesInvoice).toMatchObject({ id: inv.id, number: "00434" });
    expect((await getInvoice(fx.finance, inv.id)).replacedBy[0]?.id).toBe(replacementId);
  });
});

describe("duplikasi", () => {
  it("menyalin isi sebagai draft baru tanpa nomor, pembayaran, atau status lunas", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { downPayment: 14_000_000 }))).id);
    expect(inv.paymentStatus).toBe("PAID");
    const copy = await duplicateInvoice(fx.finance, inv.id);
    expect(copy.status).toBe("DRAFT");
    expect(copy.number).toBeNull();
    expect(copy.paymentStatus).toBe("UNPAID");
    expect(copy.amounts).toMatchObject({ total: 14_000_000, paid: 0, downPayment: 0 });
    expect(copy.duplicatedFrom?.number).toBe("00434");
    expect(await prisma.payment.count({ where: { invoiceId: copy.id } })).toBe(0);
    const issued = await issueInvoice(fx.finance, copy.id);
    expect(issued.number).toBe("00435");
  });
});

describe("hak akses di service layer", () => {
  it("STAFF: bisa buat draft; tidak bisa terbit/batal/bayar; tidak bisa ubah harga/diskon/pajak", async () => {
    const d = await createDraft(fx.staff, demiChefInput(fx));
    expect(d.createdById).toBe(fx.staff.userId);
    await expectAppError(issueInvoice(fx.staff, d.id), "FORBIDDEN");
    const issued = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    await expectAppError(cancelInvoice(fx.staff, issued.id, { reason: "tidak berwenang" }), "FORBIDDEN");
    await expectAppError(recordPayment(fx.staff, { invoiceId: issued.id, paymentDate: "2026-01-14", amount: 1000, method: "Transfer" }), "FORBIDDEN");
    const line = demiChefInput(fx).lines[0]!;
    await expectAppError(createDraft(fx.staff, demiChefInput(fx, { lines: [{ ...line, unitPrice: 1_000_000 }] })), "FORBIDDEN", /harga/);
    await expectAppError(createDraft(fx.staff, demiChefInput(fx, { lines: [{ ...line, discount: 1 }] })), "FORBIDDEN", /diskon/);
    await expectAppError(createDraft(fx.staff, demiChefInput(fx, { extraDiscount: 1 })), "FORBIDDEN", /diskon/);
    await expectAppError(createDraft(fx.staff, demiChefInput(fx, { lines: [{ ...line, taxConfigId: fx.ppnId }] })), "FORBIDDEN", /pajak/);
    await expectAppError(createDraft(fx.staff, demiChefInput(fx, { lines: [{ ...line, productId: null }] })), "FORBIDDEN", /tanpa produk/);
  });

  it("STAFF hanya melihat & mengedit invoice miliknya sendiri (404, bukan 403)", async () => {
    const mine = await createDraft(fx.staff, demiChefInput(fx));
    const theirs = await createDraft(fx.finance, demiChefInput(fx));
    await expectAppError(getInvoice(fx.staff, theirs.id), "NOT_FOUND");
    await expectAppError(updateDraft(fx.staff2, mine.id, demiChefInput(fx)), "NOT_FOUND");
    await expectAppError(deleteDraft(fx.staff2, mine.id), "NOT_FOUND");
    await expectAppError(duplicateInvoice(fx.staff2, mine.id), "NOT_FOUND");
    const list = await listInvoices(fx.staff);
    expect(list.items.map((i) => i.id)).toEqual([mine.id]);
    expect((await listInvoices(fx.finance)).total).toBe(2);
    await updateDraft(fx.staff, mine.id, demiChefInput(fx, { reference: "PO-1", expectedVersion: mine.version }));
  });

  it("FINANCE dapat override harga & diskon; hasilnya dihitung ulang server", async () => {
    const line = { ...demiChefInput(fx).lines[0]!, unitPrice: 1_500_000, discount: 500_000 };
    const d = await createDraft(fx.finance, demiChefInput(fx, { lines: [line] }));
    expect(d.amounts.total).toBe(7 * 1_500_000 - 500_000);
  });
});

describe("daftar, pencarian, filter, dan overdue", () => {
  it("filter nomor, pelanggan, status, tanggal, overdue, sort, paginasi", async () => {
    const mk = async (date: string, term: number, qty = 7) => {
      const d = await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: term, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: qty }] }));
      return issueInvoice(fx.finance, d.id);
    };
    const old = await mk("2020-01-10", 4, 1); // jatuh tempo sudah lewat jauh → overdue
    const paid = await mk("2020-02-10", 4, 2);
    await recordPayment(fx.finance, { invoiceId: paid.id, paymentDate: "2020-02-11", amount: 4_000_000, method: "Transfer" });
    const future = await mk("2099-01-10", 30, 3);
    const cancelled = await mk("2020-03-10", 4, 4);
    await cancelInvoice(fx.finance, cancelled.id, { reason: "Dibatalkan oleh pelanggan" });
    await createDraft(fx.finance, demiChefInput(fx));

    const q = (f: Parameters<typeof listInvoices>[1]) => listInvoices(fx.finance, f).then((r) => r.items);
    expect((await q({ paymentStatus: "OVERDUE" })).map((i) => i.id)).toEqual([old.id]);
    expect((await q({ paymentStatus: "PAID" })).map((i) => i.id)).toEqual([paid.id]);
    expect((await q({ paymentStatus: "UNPAID" })).map((i) => i.id).sort()).toEqual([old.id, future.id].sort());
    expect((await q({ status: "CANCELLED" })).map((i) => i.id)).toEqual([cancelled.id]);
    expect((await q({ status: "DRAFT" }))).toHaveLength(1);
    expect((await q({ q: old.number! })).map((i) => i.id)).toEqual([old.id]);
    expect(await q({ q: "bima satria" })).toHaveLength(5);
    expect(await q({ q: "tidak-ada" })).toHaveLength(0);
    expect((await q({ from: "2020-02-01", to: "2020-12-31" })).map((i) => i.id).sort()).toEqual([paid.id, cancelled.id].sort());
    expect((await q({ status: "ISSUED", sort: "total", dir: "desc" }))[0]!.id).toBe(future.id);
    expect((await q({ status: "ISSUED", sort: "number", dir: "asc" }))[0]!.id).toBe(old.id);
    const page2 = await listInvoices(fx.finance, { pageSize: 2, page: 2 });
    expect(page2.items).toHaveLength(2);
    expect(page2.pageCount).toBe(3);
    expect(page2.total).toBe(5);
    const overdueItem = (await q({ status: "ISSUED" })).find((i) => i.id === old.id)!;
    expect(overdueItem.isOverdue).toBe(true);
    expect(overdueItem.balanceAmount).toBe(2_000_000);
  });
});

describe("draft: hapus & jejak audit", () => {
  it("draft dapat dihapus; audit mencatat pembuatan, penerbitan, dan penghapusan dengan pelaku", async () => {
    const d = await createDraft(fx.finance, demiChefInput(fx));
    await deleteDraft(fx.finance, d.id);
    expect(await prisma.invoice.count()).toBe(0);
    expect(await prisma.invoiceItem.count()).toBe(0);

    const d2 = await createDraft(fx.finance, demiChefInput(fx));
    await updateDraft(fx.finance, d2.id, demiChefInput(fx, { transport: 1000 }));
    const inv = await issueInvoice(fx.finance, d2.id);
    await cancelInvoice(fx.finance, inv.id, { reason: "Uji audit pembatalan" });

    const logs = await prisma.auditLog.findMany({ where: { entityType: "Invoice", entityId: d2.id }, orderBy: { id: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["invoice.create_draft", "invoice.update_draft", "invoice.issue", "invoice.cancel"]);
    expect(logs.every((l) => l.actorId === fx.finance.userId && l.actorRole === "FINANCE")).toBe(true);
    const upd = logs[1]!;
    expect((upd.before as { totalAmount: number }).totalAmount).toBe(14_000_000);
    expect((upd.after as { transport: number }).transport).toBe(1000);
    expect(logs[3]!.reason).toBe("Uji audit pembatalan");
    expect(await prisma.auditLog.count({ where: { action: "invoice.delete_draft" } })).toBe(1);
  });
});
