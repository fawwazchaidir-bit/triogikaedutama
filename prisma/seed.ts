/**
 * SEED PRODUKSI — aman dijalankan berulang (idempoten) dan TIDAK menimpa data yang sudah diubah administrator.
 *
 *  • Menginisialisasi identitas lembaga (hanya bila belum ada).
 *  • Membuat rekening bank awal, produk contoh (Demi Chef), dan logo/cap bawaan.
 *  • Membuat akun Administrator PERTAMA dari ADMIN_EMAIL / ADMIN_PASSWORD (tidak ada password default;
 *    seed gagal bila kosong atau lemah). Dilewati bila sudah ada Administrator.
 *  • Tidak membuat pelanggan/invoice/pembayaran dan TIDAK mengaktifkan penomoran: Administrator harus
 *    mengonfirmasi nomor awal di Pengaturan → Penomoran sebelum invoice pertama dapat diterbitkan.
 *
 * Data demo ada di seed-dev.ts (terpisah).
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { hashPassword, validatePasswordStrength } from "../src/server/auth/password";

const prisma = new PrismaClient();

async function seedAsset(kind: "LOGO" | "STAMP", file: string, uploadedById: string): Promise<string> {
  const data = readFileSync(path.join(__dirname, "seed-assets", file));
  const f = await prisma.storedFile.create({
    data: {
      kind, originalName: file, mimeType: "image/png", size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"), data, uploadedById,
    },
  });
  return f.id;
}

async function ensureAdmin(): Promise<string> {
  const existing = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (existing) {
    console.log(`• Administrator sudah ada (${existing.email}) — dilewati.`);
    return existing.id;
  }
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  const name = process.env.ADMIN_NAME?.trim() || "Administrator";
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL dan ADMIN_PASSWORD wajib diisi untuk membuat Administrator pertama (lihat .env.example).");
  }
  const weak = validatePasswordStrength(password, { email, name });
  if (weak) throw new Error(`ADMIN_PASSWORD ditolak: ${weak}`);
  const admin = await prisma.user.create({
    data: { email, name, role: "ADMIN", passwordHash: await hashPassword(password), mustChangePassword: true },
  });
  await prisma.auditLog.create({
    data: { actorId: admin.id, actorEmail: admin.email, actorRole: "ADMIN", action: "user.create", entityType: "User", entityId: admin.id, summary: "Administrator pertama dibuat oleh seed" },
  });
  console.log(`• Administrator dibuat: ${email} (wajib ganti password saat login pertama).`);
  return admin.id;
}

async function main() {
  const adminId = await ensureAdmin();

  if (!(await prisma.companySettings.findUnique({ where: { id: 1 } }))) {
    const logoId = await seedAsset("LOGO", "logo.png", adminId);
    const stampId = await seedAsset("STAMP", "stamp.png", adminId);
    await prisma.companySettings.create({
      data: {
        id: 1,
        name: "TRILOGIKA EDUTAMA",
        tagline: "Light & Insight",
        address: "Jambon 01/21, Trihanggo, Gamping, Sleman",
        phone: "0857-0124-6319",
        email: "info@trilogikaedutama.id",
        npwp: "65.472.603.3-542.000",
        logoFileId: logoId,
        stampFileId: stampId,
        signerName: "Elva Aditya Fawwaz, S.E.",
        signerTitle: "Finance",
        closingText: "Sincerely,",
        defaultPaymentMethod: "Transfer",
        defaultPaymentTermDays: 4,
        defaultDueDateBasis: "CALENDAR_DAYS",
        // Contoh dari invoice referensi. Administrator WAJIB mengonfirmasi nomor awal sebelum penerbitan.
        invoiceNumberFormat: "{SEQ:5}",
        invoiceNumberPrefix: "",
        invoiceNumberReset: "NEVER",
        invoiceNumberStart: 434,
        invoiceNumberConfirmedAt: null,
        showLogo: true,
        showStamp: true,
        showSignature: false,
        rupiahStyle: "REFERENCE",
        terbilangSource: "TOTAL",
      },
    });
    console.log("• Pengaturan perusahaan diinisialisasi (nomor invoice belum dikonfirmasi).");
  } else {
    console.log("• Pengaturan perusahaan sudah ada — tidak diubah.");
  }

  if ((await prisma.bankAccount.count()) === 0) {
    await prisma.bankAccount.create({
      data: { label: "MANDIRI-IDR", accountNumber: "137-00-2072139-1", accountName: "Trilogika Edutama", isDefault: true },
    });
    console.log("• Rekening bank awal dibuat.");
  }

  if (!(await prisma.product.findUnique({ where: { code: "DEMI-CHEF" } }))) {
    await prisma.product.create({
      data: {
        code: "DEMI-CHEF",
        name: "Biaya Diklat & Uji Kompetensi",
        category: "Diklat & Sertifikasi",
        fieldOfTraining: "Food Production",
        schemeName: "Demi Chef",
        descriptionTemplate: "{name}\nBidang {field}\n(Skema {scheme})",
        unit: "Pax",
        defaultPrice: 2_000_000n,
      },
    });
    console.log("• Produk awal Demi Chef dibuat.");
  }
}

main()
  .then(() => console.log("Seed produksi selesai."))
  .catch((e) => { console.error(`\nSeed GAGAL: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
