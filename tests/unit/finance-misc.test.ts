import { describe, expect, it } from "vitest";
import { addBusinessDays, computeDueDate, diffDays, isValidIsoDate } from "@/lib/finance/due-date";
import {
  findUnknownPlaceholders,
  flattenDescription,
  renderDescription,
  DEFAULT_DESCRIPTION_TEMPLATE,
} from "@/lib/finance/description-template";
import {
  formatInvoiceNumber,
  numberForFilename,
  scopeKeyFor,
  validateNumberFormat,
} from "@/lib/finance/invoice-number";
import { formatRupiah, formatNumberId, parseRupiahInput } from "@/lib/finance/money";
import { formatDateLong, formatDateShort, todayIso } from "@/lib/format";
import { can, ROLE_LABELS, ROLE_PERMISSIONS, PERMISSIONS, visibleNav } from "@/lib/permissions";

describe("tanggal jatuh tempo", () => {
  it("contoh brief: 13 Jan 2026 + 4 hari kalender = 17 Jan 2026", () => {
    expect(computeDueDate("2026-01-13", 4, "CALENDAR_DAYS")).toBe("2026-01-17");
  });
  it("lintas bulan, tahun, dan tahun kabisat", () => {
    expect(computeDueDate("2026-01-30", 3)).toBe("2026-02-02");
    expect(computeDueDate("2025-12-30", 5)).toBe("2026-01-04");
    expect(computeDueDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(computeDueDate("2026-02-28", 1)).toBe("2026-03-01");
  });
  it("0 hari = tanggal invoice", () => {
    expect(computeDueDate("2026-01-13", 0)).toBe("2026-01-13");
  });
  it("hari kerja melewati akhir pekan (Jumat 16 Jan + 1 hari kerja = Senin 19 Jan)", () => {
    expect(computeDueDate("2026-01-16", 1, "BUSINESS_DAYS")).toBe("2026-01-19");
    expect(computeDueDate("2026-01-13", 4, "BUSINESS_DAYS")).toBe("2026-01-19"); // Selasa + 4 hari kerja
  });
  it("hari libur yang diberikan dikecualikan", () => {
    expect(addBusinessDays("2026-01-16", 1, ["2026-01-19"])).toBe("2026-01-20");
  });
  it("menolak tanggal & jangka waktu tidak valid", () => {
    expect(() => computeDueDate("2026-02-31", 3)).toThrow();
    expect(() => computeDueDate("13/01/2026", 3)).toThrow();
    expect(() => computeDueDate("2026-01-13", -1)).toThrow();
    expect(() => computeDueDate("2026-01-13", 1.5)).toThrow();
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2028-02-29")).toBe(true);
  });
  it("diffDays", () => {
    expect(diffDays("2026-01-13", "2026-01-17")).toBe(4);
    expect(diffDays("2026-01-17", "2026-01-13")).toBe(-4);
  });
});

describe("template deskripsi produk", () => {
  const demiChef = { name: "Biaya Diklat & Uji Kompetensi", field: "Food Production", scheme: "Demi Chef" };
  it("menghasilkan deskripsi persis seperti invoice referensi", () => {
    expect(renderDescription(DEFAULT_DESCRIPTION_TEMPLATE, demiChef)).toBe(
      "Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)",
    );
  });
  it("membuang baris yang placeholder-nya kosong", () => {
    expect(renderDescription(DEFAULT_DESCRIPTION_TEMPLATE, { name: "Pelatihan Barista", field: "F&B" })).toBe(
      "Pelatihan Barista\nBidang F&B",
    );
    expect(renderDescription(DEFAULT_DESCRIPTION_TEMPLATE, { name: "X", field: "  ", scheme: null })).toBe("X");
  });
  it("flatten untuk kolom Remark", () => {
    expect(flattenDescription("Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)")).toBe(
      "Biaya Diklat & Uji Kompetensi Bidang Food Production (Skema Demi Chef)",
    );
  });
  it("mendeteksi placeholder tidak dikenal", () => {
    expect(findUnknownPlaceholders("{name} {harga} {scheme} {x}")).toEqual(["harga", "x"]);
    expect(findUnknownPlaceholders(DEFAULT_DESCRIPTION_TEMPLATE)).toEqual([]);
  });
});

describe("format & scope nomor invoice", () => {
  it("default: 00434, 00435, 00436", () => {
    for (const [seq, out] of [[434, "00434"], [435, "00435"], [436, "00436"]] as const) {
      expect(formatInvoiceNumber({ format: "{SEQ:5}", seq, date: "2026-01-13" })).toBe(out);
    }
  });
  it("format lain: INV/TE/2026/0001", () => {
    expect(formatInvoiceNumber({ format: "INV/TE/{YYYY}/{SEQ:4}", seq: 1, date: "2026-01-13" })).toBe("INV/TE/2026/0001");
    expect(formatInvoiceNumber({ format: "{PREFIX}{YY}{MM}-{SEQ:3}", prefix: "TE", seq: 7, date: "2026-03-02" })).toBe("TE2603-007");
  });
  it("nomor melebihi padding tidak dipotong", () => {
    expect(formatInvoiceNumber({ format: "{SEQ:5}", seq: 123456, date: "2026-01-01" })).toBe("123456");
  });
  it("scope mengikuti kebijakan reset", () => {
    expect(scopeKeyFor("NEVER", "2026-01-13")).toBe("ALL");
    expect(scopeKeyFor("YEARLY", "2026-01-13")).toBe("2026");
    expect(scopeKeyFor("MONTHLY", "2026-01-13")).toBe("2026-01");
  });
  it("validasi format", () => {
    expect(validateNumberFormat("{SEQ:5}").ok).toBe(true);
    expect(validateNumberFormat("INV/TE/{YYYY}/{SEQ:4}").ok).toBe(true);
    expect(validateNumberFormat("INV-{YYYY}").ok).toBe(false); // tanpa SEQ
    expect(validateNumberFormat("{SEQ}{SEQ}").ok).toBe(false); // dua SEQ
    expect(validateNumberFormat("{FOO}{SEQ}").ok).toBe(false); // token tidak dikenal
    expect(validateNumberFormat("<b>{SEQ}").ok).toBe(false); // karakter berbahaya
    expect(validateNumberFormat("{SEQ:99}").ok).toBe(false);
    expect(validateNumberFormat("{SEQ}", "../x").ok).toBe(false);
    expect(validateNumberFormat("{SEQ}", "").ok).toBe(true);
  });
  it("nama file aman", () => {
    expect(numberForFilename("INV/TE/2026/0001")).toBe("INV-TE-2026-0001");
    expect(numberForFilename("00434")).toBe("00434");
  });
});

describe("format Rupiah", () => {
  it("tiga gaya", () => {
    expect(formatRupiah(14_000_000, "REFERENCE")).toBe("Rp. 14.000.000,-");
    expect(formatRupiah(14_000_000, "PLAIN")).toBe("Rp 14.000.000");
    expect(formatRupiah(14_000_000, "DECIMAL")).toBe("Rp 14.000.000,00");
    expect(formatRupiah(0, "REFERENCE")).toBe("Rp. 0,-");
    expect(formatRupiah(-5_000, "PLAIN")).toBe("-Rp 5.000");
  });
  it("pemisah ribuan", () => {
    expect(formatNumberId(999)).toBe("999");
    expect(formatNumberId(1_000)).toBe("1.000");
    expect(formatNumberId(1_234_567_890)).toBe("1.234.567.890");
  });
  it("parse input pengguna", () => {
    expect(parseRupiahInput("14000000")).toBe(14_000_000);
    expect(parseRupiahInput("Rp. 14.000.000,-")).toBe(14_000_000);
    expect(parseRupiahInput("14.000.000,00")).toBe(14_000_000);
    expect(parseRupiahInput(2_000_000)).toBe(2_000_000);
    expect(parseRupiahInput("14.000.000,50")).toBeNull();
    expect(parseRupiahInput("1.4000.000")).toBeNull();
    expect(parseRupiahInput("abc")).toBeNull();
    expect(parseRupiahInput("")).toBeNull();
    expect(parseRupiahInput(-1)).toBeNull();
    expect(parseRupiahInput(1.5)).toBeNull();
  });
});

describe("tanggal tampilan", () => {
  it("format", () => {
    expect(formatDateShort("2026-01-13")).toBe("13/01/2026");
    expect(formatDateLong("2026-01-13")).toBe("13 Januari 2026");
  });
  it("todayIso mengikuti zona waktu Jakarta (UTC+7), bukan UTC", () => {
    // 2026-01-12 18:00 UTC = 2026-01-13 01:00 WIB
    expect(todayIso("Asia/Jakarta", new Date("2026-01-12T18:00:00Z"))).toBe("2026-01-13");
    expect(todayIso("UTC", new Date("2026-01-12T18:00:00Z"))).toBe("2026-01-12");
  });
});

describe("matriks hak akses (least privilege)", () => {
  it("ADMIN memiliki seluruh izin", () => {
    for (const p of PERMISSIONS) expect(can("ADMIN", p)).toBe(true);
  });
  it("STAFF Operasional: input lengkap, mengajukan, mencatat pembayaran, laporan; tanpa approval, pembatalan, pembalikan pembayaran, dashboard, dan administrasi sistem", () => {
    for (const p of [
      "invoice:approve", "invoice:cancel", "payment:reverse", "dashboard:view", "audit:view",
      "finance:view", "finance:manage", "cash:record", "expense:approve", "expense:void", "journal:record", "books:lock", "bank:reconcile",
      "settings:manage", "numbering:manage", "tax:manage", "user:manage", "product:manage",
    ] as const) {
      expect(can("STAFF", p), p).toBe(false);
    }
    for (const p of [
      "invoice:create", "invoice:override_price", "invoice:discount", "invoice:submit", "invoice:preview_draft",
      "invoice:view", "invoice:pdf", "invoice:history",
      "payment:view", "payment:record", "report:view", "settings:view", "customer:update", "customer:archive",
      "expense:record", "expense:view_own",
    ] as const) {
      expect(can("STAFF", p), p).toBe(true);
    }
  });
  it("beda Staff Operasional dengan Finance Manager: approval/koreksi/kas & laporan keuangan/dashboard; staff menambah pengajuan & melihat pengeluaran sendiri", () => {
    const f = ROLE_PERMISSIONS.FINANCE, st = ROLE_PERMISSIONS.STAFF;
    expect([...f].filter((p) => !st.has(p)).sort()).toEqual([
      "bank:reconcile", "books:lock", "cash:record", "dashboard:view", "expense:approve", "expense:void", "finance:view", "invoice:approve", "invoice:cancel", "journal:record", "payment:reverse",
    ]);
    expect([...st].filter((p) => !f.has(p)).sort()).toEqual(["expense:view_own", "invoice:submit"]);
  });
  it("FINANCE Manager: memverifikasi (setujui/kembalikan) dan melihat seluruh invoice; tidak mengelola pengguna, penomoran, pajak, atau audit log", () => {
    for (const p of ["user:manage", "numbering:manage", "tax:manage", "settings:manage", "audit:view", "product:manage"] as const) {
      expect(can("FINANCE", p), p).toBe(false);
    }
    for (const p of [
      "invoice:approve", "invoice:view", "invoice:history", "invoice:cancel", "payment:record", "invoice:pdf", "invoice:preview_draft", "report:view",
    ] as const) {
      expect(can("FINANCE", p), p).toBe(true);
    }
    // pengajuan adalah tugas staff; penyetuju menerbitkan langsung
    expect(can("FINANCE", "invoice:submit")).toBe(false);
  });
  it("hanya penyetuju (Finance Manager & Administrator) yang dapat menyetujui invoice", () => {
    expect((["ADMIN", "FINANCE", "STAFF"] as const).filter((r) => can(r, "invoice:approve"))).toEqual(["ADMIN", "FINANCE"]);
    expect(ROLE_LABELS).toEqual({ ADMIN: "Administrator", FINANCE: "Finance Manager", STAFF: "Staff Operasional" });
  });
  it("menu sidebar sesuai peran (staff: tanpa Dashboard, dengan Pembayaran & Laporan)", () => {
    const labels = (r: "ADMIN" | "FINANCE" | "STAFF") => visibleNav(r).map((i) => i.label);
    expect(labels("ADMIN")).toEqual(["Dashboard", "Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Pengeluaran", "Kas & Bank", "Rekonsiliasi Bank", "Jurnal", "Laporan", "Laporan Keuangan", "Pajak", "Audit Log", "Pengaturan"]);
    expect(labels("FINANCE")).toEqual(["Dashboard", "Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Pengeluaran", "Kas & Bank", "Rekonsiliasi Bank", "Jurnal", "Laporan", "Laporan Keuangan", "Pajak", "Pengaturan"]);
    expect(labels("STAFF")).toEqual(["Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Pengeluaran", "Laporan", "Pengaturan"]);
  });
  it("tanpa role = tanpa izin", () => {
    expect(can(null, "dashboard:view")).toBe(false);
    expect(can(undefined, "invoice:create")).toBe(false);
    expect(ROLE_PERMISSIONS.STAFF.size).toBeLessThan(ROLE_PERMISSIONS.FINANCE.size);
  });
});
