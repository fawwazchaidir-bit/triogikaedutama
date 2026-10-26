import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, makeProof, type Fixtures } from "../helpers/db";
import { approveEntry, createEntry, reverseEntry, createTransfer } from "@/server/services/cash-entries";
import { listCashAccounts } from "@/server/services/cash-accounts";
import { PROOF_REQUIRED_ABOVE } from "@/lib/accounting/limits";
import { AppError } from "@/server/errors";

/** Aturan: uang KELUAR (entri kas manual) di atas Rp1.000.000 wajib melampirkan bukti transaksi — di service DAN di trigger database. */
let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true });
});
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
const mk = (actor: typeof fx.finance, o: Record<string, unknown>) =>
  createEntry(actor, { entryDate: "2026-03-09", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], description: "Uji bukti", direction: "OUT", amount: 500_000, ...o });

describe("bukti wajib untuk pengeluaran > Rp1.000.000", () => {
  it("ambang: tepat Rp1.000.000 boleh tanpa bukti; Rp1.000.001 wajib berbukti", async () => {
    expect(PROOF_REQUIRED_ABOVE).toBe(1_000_000);
    expect((await mk(fx.finance, { amount: 1_000_000 })).amount).toBe(1_000_000);
    const e = await err(mk(fx.finance, { amount: 1_000_001 }));
    expect(e).toMatchObject({ code: "VALIDATION" });
    expect(e!.fieldErrors?.proofFileId).toMatch(/wajib/i);
    expect(e!.message).toMatch(/wajib melampirkan bukti transaksi/);
    expect((await mk(fx.finance, { amount: 1_000_001, proofFileId: await makeProof(fx.finance) })).proofFileId).toBeTruthy();
    expect(await prisma.cashEntry.count()).toBe(2); // yang ditolak tidak meninggalkan baris
  });

  it("berlaku untuk semua peran: staff, Finance Manager, Admin; pengajuan staff berbukti dapat disetujui", async () => {
    for (const a of [fx.staff, fx.finance, fx.admin]) expect((await err(mk(a, { amount: 2_500_000 })))?.code, a.role).toBe("VALIDATION");
    const pend = await mk(fx.staff, { amount: 2_500_000, proofFileId: await makeProof(fx.staff) });
    expect(pend.status).toBe("PENDING");
    expect((await approveEntry(fx.finance, pend.id)).status).toBe("APPROVED");
    expect((await listCashAccounts(fx.finance)).find((a) => a.id === fx.bankAcctId)!.balance).toBe(10_000_000 - 2_500_000);
  });

  it("berlaku untuk SEMUA uang keluar: beban, pembelian aset, prive, pembayaran pinjaman — tidak untuk uang masuk", async () => {
    const out = (counter: string) => mk(fx.finance, { counterAccountId: fx.coa[counter], amount: 3_000_000 });
    for (const c of ["6-1300", "1-2100", "3-1200", "2-2100"]) expect((await err(out(c)))?.code, c).toBe("VALIDATION");
    for (const c of ["4-2200", "3-1100", "2-2100", "1-2200"]) {
      expect((await mk(fx.finance, { counterAccountId: fx.coa[c], direction: "IN", amount: 5_000_000 })).direction, c).toBe("IN"); // penerimaan tak wajib bukti
    }
  });

  it("pembalikan dikecualikan (mengikuti entri asal); transfer antar akun tidak memerlukan bukti", async () => {
    const e = await mk(fx.finance, { amount: 4_000_000, proofFileId: await makeProof(fx.finance) });
    const rev = await reverseEntry(fx.finance, e.id, { reason: "Salah input" });
    expect(rev).toMatchObject({ entryType: "REVERSAL", amount: 4_000_000, proofFileId: null });
    await createTransfer(fx.finance, { transferDate: "2026-03-09", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 5_000_000 });
  });

  it("bukti tetap divalidasi: harus berjenis EXPENSE_PROOF dan unggahan sendiri; bukti kosong/rusak tidak lolos", async () => {
    const theirs = await makeProof(fx.staff2);
    expect((await err(mk(fx.staff, { amount: 2_000_000, proofFileId: theirs })))?.code).toBe("VALIDATION");
    expect((await err(mk(fx.staff, { amount: 2_000_000, proofFileId: "" })))?.fieldErrors?.proofFileId).toMatch(/wajib/i);
    expect((await err(mk(fx.staff, { amount: 2_000_000, proofFileId: null })))?.code).toBe("VALIDATION");
    expect((await err(mk(fx.staff, { amount: 2_000_000, proofFileId: "11111111-1111-4111-8111-111111111111" })))?.code).toBe("VALIDATION");
  });

  it("pagar database: INSERT mentah pengeluaran > Rp1 juta tanpa bukti ditolak; dengan bukti & ≤ Rp1 juta diterima", async () => {
    const raw = (amount: number, proof: string | null) => prisma.$executeRawUnsafe(`INSERT INTO cash_entries (id,"entryType","entryDate",direction,amount,"cashAccountId","counterAccountId",description,status,"createdById","proofFileId")
      VALUES (gen_random_uuid(),'ENTRY','2026-03-09','OUT',${amount},'${fx.bankAcctId}','${fx.coa["6-1300"]}','raw','PENDING','${fx.finance.userId}',${proof ? `'${proof}'` : "NULL"})`);
    await expect(raw(1_000_001, null)).rejects.toThrow(/wajib melampirkan bukti transaksi/);
    await expect(raw(99_999_999, null)).rejects.toThrow(/wajib melampirkan bukti transaksi/);
    await expect(raw(1_000_000, null)).resolves.toBe(1);
    await expect(raw(1_000_001, await makeProof(fx.finance))).resolves.toBe(1);
  });

  it("transaksi gagal tidak meninggalkan jejak: tak ada baris, tak ada audit, saldo tetap", async () => {
    const before = await prisma.auditLog.count();
    await err(mk(fx.finance, { amount: 9_000_000 }));
    expect(await prisma.cashEntry.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(before);
    expect((await listCashAccounts(fx.finance)).find((a) => a.id === fx.bankAcctId)!.balance).toBe(10_000_000);
  });
});
