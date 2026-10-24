import { Document, Font, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";


/**
 * Template PDF invoice — A4 portrait. Meniru invoice referensi Trilogika (Word):
 *   header (logo + identitas | INVOICE + nomor/tanggal/term/jatuh tempo) → Customer → tabel bergaris putus-putus →
 *   Inword/Remark/Transfer Via | ringkasan biaya → Sincerely / Finance / penandatangan.
 *
 * Komponen ini MURNI presentasi: seluruh teks & nominal sudah diformat di `document-data.ts` dari SNAPSHOT tersimpan.
 * Font Times (bawaan PDF, tidak perlu di-embed) = padanan Times New Roman pada dokumen referensi.
 */

type Style = NonNullable<React.ComponentProps<typeof View>["style"]>;

export interface PdfImage { data: Buffer; format: "png" | "jpg" }

export interface InvoicePdfData {
  watermark: "DRAFT" | "DIBATALKAN" | null;
  company: {
    name: string; tagline: string | null; addressLines: string[]; phone: string | null; email: string | null; npwp: string | null;
    signerName: string; signerTitle: string; closingText: string; paymentNote: string | null; footerNote: string | null;
    logo: PdfImage | null; stamp: PdfImage | null; signature: PdfImage | null;
  };
  meta: { number: string; invoiceDate: string; paymentTerm: string; dueDate: string };
  customerName: string;
  lines: { no: number; descriptionLines: string[]; quantity: string; unitPrice: string; netAmount: string; note: string | null }[];
  inword: string;
  remark: string | null;
  bank: { label: string; accountNumber: string; accountName: string } | null;
  /** Baris ringkasan; `rule` = garis putus-putus di bawah baris. */
  summary: { label: string; value: string; bold?: boolean; rule?: boolean }[];
}

// Jangan memotong kata dengan tanda hubung ("Produc-tion"): nama & istilah harus utuh.
Font.registerHyphenationCallback((word) => [word]);

const INK = "#000000";
const DASH = { borderStyle: "dashed" as const, borderColor: INK, borderWidth: 0 };

const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 54, paddingHorizontal: 40, fontFamily: "Times-Roman", fontSize: 10.5, color: INK },
  // lineHeight sengaja BUKAN di Page: pada react-pdf, lineHeight tingkat-halaman membuat teks `render` (nomor halaman) berukuran nol.
  content: { lineHeight: "13pt" },
  bold: { fontFamily: "Times-Bold" },

  header: { flexDirection: "row", justifyContent: "space-between" },
  brand: { flexDirection: "row", width: "58%" },
  logo: { width: 62, height: 62, marginRight: 10 },
  brandText: { flex: 1 },
  companyName: { fontFamily: "Times-Bold", fontSize: 11.5 },
  tagline: { fontFamily: "Times-BoldItalic", marginBottom: 1 },
  kv: { flexDirection: "row" },
  kvLabel: { width: 36 },

  right: { width: "40%" },
  title: { fontFamily: "Times-Bold", fontSize: 18, textAlign: "right", marginBottom: 8, letterSpacing: 0.5 },
  statusTag: { fontFamily: "Times-Bold", fontSize: 11, textAlign: "right", marginTop: -4, marginBottom: 6 },
  metaRow: { flexDirection: "row", marginBottom: 2 },
  metaLabel: { width: 76 },
  metaValue: { flex: 1 },

  customer: { flexDirection: "row", marginTop: 16, marginBottom: 6 },
  customerLabel: { width: 62 },

  ruleTop: { ...DASH, borderTopWidth: 1.6 },
  ruleBottom: { ...DASH, borderBottomWidth: 1.6 },
  tableHead: { flexDirection: "row", paddingVertical: 5, borderTopWidth: 1.6, borderBottomWidth: 1.6, borderStyle: "dashed", borderColor: INK },
  cNo: { width: 30 },
  cDesc: { flex: 1, paddingRight: 8 },
  cQty: { width: 70 },
  cPrice: { width: 92, textAlign: "right" },
  cNet: { width: 98, textAlign: "right" },
  row: { flexDirection: "row", paddingTop: 5 },
  rowNote: { fontFamily: "Times-Italic", fontSize: 9.5 },

  bottom: { flexDirection: "row", borderTopWidth: 1.6, borderStyle: "dashed", borderColor: INK, paddingTop: 5 },
  bottomLeft: { flex: 1, paddingRight: 14 },
  bottomRight: { width: 224 },
  lr: { flexDirection: "row", marginBottom: 2 },
  lrLabel: { width: 50 },
  transfer: { marginTop: 10 },
  underline: { textDecoration: "underline", fontFamily: "Times-Bold" },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5 },
  sumRule: { borderBottomWidth: 1.6, borderStyle: "dashed", borderColor: INK, marginBottom: 3, paddingBottom: 3 },

  closing: { marginTop: 16, alignItems: "center", height: 118 },
  stamp: { position: "absolute", top: 24, left: "50%", marginLeft: -62, width: 86, height: 86, opacity: 0.85 },
  signature: { position: "absolute", top: 24, left: "50%", marginLeft: -6, width: 64, height: 62 },
  signer: { position: "absolute", bottom: 0 },

  watermark: {
    position: "absolute", top: 320, left: 0, right: 0, textAlign: "center", fontFamily: "Times-Bold", fontSize: 96,
    transform: "rotate(-30deg)", opacity: 0.12, letterSpacing: 6,
  },
  footerNote: { position: "absolute", left: 40, right: 140, bottom: 24, fontSize: 8.5, color: "#444444" },
  pageNo: { position: "absolute", right: 40, bottom: 24, width: 140, fontSize: 8.5, color: "#444444", textAlign: "right" },
});

/** Perkiraan tinggi blok total + penutup (pt) — ambang `minPresenceAhead` untuk baris terakhir. */
const TOTAL_BLOCK_HEIGHT = 300;
const MIN_BODY_HEIGHT = 150;

/** Perkiraan tinggi baris untuk menghitung spacer (hanya kosmetik; kesalahan kecil tidak berdampak). */
function spacerHeight(lines: InvoicePdfData["lines"]): number {
  const used = lines.reduce((sum, l) => {
    const textLines = l.descriptionLines.reduce((n, d) => n + Math.max(1, Math.ceil(d.length / 44)), 0) + (l.note ? 1 : 0);
    return sum + textLines * 13.2 + 5;
  }, 0);
  return Math.max(0, MIN_BODY_HEIGHT - used);
}

function Pair({ label, value, labelStyle, bold }: { label: string; value: string; labelStyle: Style; bold?: boolean }) {
  return (
    <View style={s.kv}>
      <Text style={[labelStyle, bold ? s.bold : {}]}>{label}</Text>
      <Text style={bold ? s.bold : undefined}>: {value}</Text>
    </View>
  );
}

export function InvoicePdf({ data }: { data: InvoicePdfData }) {
  const c = data.company;
  return (
    <Document title={`Invoice ${data.meta.number}`} author={c.name} subject={`Invoice ${data.meta.number} — ${data.customerName}`} creator="Trilogika Invoice System" producer="Trilogika Invoice System">
      <Page size="A4" style={s.page}>
        {data.watermark && <Text fixed style={[s.watermark, { color: data.watermark === "DIBATALKAN" ? "#B3161F" : "#555555" }]}>{data.watermark}</Text>}

        <View style={s.content}>
        {/* ── Header ── */}
        <View style={s.header}>
          <View style={s.brand}>
            {c.logo && <Image src={{ data: c.logo.data, format: c.logo.format }} style={s.logo} />}
            <View style={s.brandText}>
              <Text style={s.companyName}>{c.name}</Text>
              {c.tagline && <Text style={s.tagline}>“{c.tagline}”</Text>}
              {c.addressLines.map((l, i) => <Text key={i}>{l}</Text>)}
              {c.phone && <Pair label="Phone" value={c.phone} labelStyle={s.kvLabel} />}
              {c.email && <Pair label="Email" value={c.email} labelStyle={s.kvLabel} />}
              {c.npwp && <Pair label="NPWP" value={c.npwp} labelStyle={s.kvLabel} />}
            </View>
          </View>
          <View style={s.right}>
            <Text style={s.title}>INVOICE</Text>
            {data.watermark && (
              <Text style={[s.statusTag, { color: data.watermark === "DIBATALKAN" ? "#B3161F" : "#444444" }]}>** {data.watermark} **</Text>
            )}
            <Pair label="Number" value={data.meta.number} labelStyle={s.metaLabel} bold />
            <Pair label="Inv. Date" value={data.meta.invoiceDate} labelStyle={s.metaLabel} />
            <Pair label="Payment Term" value={data.meta.paymentTerm} labelStyle={s.metaLabel} />
            <Pair label="Due Date" value={data.meta.dueDate} labelStyle={s.metaLabel} />
          </View>
        </View>

        {/* ── Customer ── */}
        <View style={s.customer}>
          <Text style={s.customerLabel}>Customer</Text>
          <Text style={s.bold}>: {data.customerName}</Text>
        </View>

        {/* ── Tabel rincian (header diulang di halaman berikutnya) ── */}
        <View fixed style={s.tableHead}>
          <Text style={[s.cNo, s.bold]}>No.</Text>
          <Text style={[s.cDesc, s.bold]}>Product Description</Text>
          <Text style={[s.cQty, s.bold]}>Quantity</Text>
          <Text style={[s.cPrice, s.bold]}>Unit Price</Text>
          <Text style={[s.cNet, s.bold]}>Nett Amount</Text>
        </View>
        <View>
          {data.lines.map((l, idx) => (
            <View
              key={l.no}
              style={s.row}
              wrap={false}
              // Baris terakhir ikut pindah bersama blok total bila ruang tersisa terlalu sempit
              // (total tidak boleh terpisah dari konteks barisnya).
              minPresenceAhead={idx === data.lines.length - 1 ? TOTAL_BLOCK_HEIGHT : 0}
            >
              <Text style={s.cNo}>{l.no}</Text>
              <View style={s.cDesc}>
                {l.descriptionLines.map((d, i) => <Text key={i}>{d}</Text>)}
                {l.note && <Text style={s.rowNote}>{l.note}</Text>}
              </View>
              <Text style={s.cQty}>{l.quantity}</Text>
              <Text style={s.cPrice}>{l.unitPrice}</Text>
              <Text style={s.cNet}>{l.netAmount}</Text>
            </View>
          ))}

          {/* Spacer: menjaga siluet dokumen (blok total berada di posisi serupa invoice referensi) untuk invoice pendek. */}
          <View style={{ height: spacerHeight(data.lines) }} />

          {/* ── Inword / Remark / Transfer | Ringkasan (satu blok, tidak dipecah antar halaman) ── */}
          <View wrap={false}>
            <View style={s.bottom}>
              <View style={s.bottomLeft}>
                <View style={s.lr}><Text style={s.lrLabel}>Inword</Text><Text style={{ flex: 1 }}>: {data.inword}</Text></View>
                {data.remark && <View style={s.lr}><Text style={s.lrLabel}>Remark</Text><Text style={{ flex: 1 }}>: {data.remark}</Text></View>}
                {data.bank && (
                  <View style={s.transfer}>
                    <Text style={s.underline}>Transfer Via</Text>
                    <Text style={s.bold}>{data.bank.label}</Text>
                    <View style={s.kv}><Text style={[s.bold, { width: 32 }]}>A/C</Text><Text style={s.bold}>: {data.bank.accountNumber}</Text></View>
                    <View style={s.kv}><Text style={[s.bold, { width: 32 }]}>A/N</Text><Text style={s.bold}>: {data.bank.accountName}</Text></View>
                  </View>
                )}
                {c.paymentNote && <Text style={{ marginTop: 8, fontSize: 9.5 }}>{c.paymentNote}</Text>}
              </View>
              <View style={s.bottomRight}>
                {data.summary.map((r, i) => (
                  <View key={i} style={r.rule ? [s.sumRow, s.sumRule] : s.sumRow}>
                    <Text style={r.bold ? s.bold : undefined}>{r.label}</Text>
                    <Text style={r.bold ? s.bold : undefined}>{r.value}</Text>
                  </View>
                ))}
              </View>
            </View>

            {/* ── Penutup ── */}
            <View style={s.closing}>
              {/* Cap & tanda tangan digambar LEBIH DULU agar teks tetap terbaca di atasnya. */}
              {c.stamp && <Image src={{ data: c.stamp.data, format: c.stamp.format }} style={s.stamp} />}
              {c.signature && <Image src={{ data: c.signature.data, format: c.signature.format }} style={s.signature} />}
              <Text>{c.closingText}</Text>
              <Text>{c.signerTitle}</Text>
              <Text style={s.signer}>({c.signerName})</Text>
            </View>
          </View>
        </View>

        </View>

        {c.footerNote && <Text fixed style={s.footerNote}>{c.footerNote}</Text>}
        {/* Selalu non-kosong: react-pdf mengukur kotak teks pada pass pertama (totalPages belum final). */}
        <Text fixed style={s.pageNo} render={({ pageNumber, totalPages }) => `Halaman ${pageNumber} / ${totalPages}`} />
      </Page>
    </Document>
  );
}
