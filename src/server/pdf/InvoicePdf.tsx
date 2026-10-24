/* eslint-disable jsx-a11y/alt-text -- <Image> milik @react-pdf/renderer (bukan elemen DOM); PDF tidak memakai atribut alt */
import { Document, Font, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";


/**
 * Template PDF invoice — A4 LANDSCAPE. Turunan invoice referensi Trilogika (Word):
 *   header (logo + identitas | judul INVOICE di tengah | nomor/tanggal/term/jatuh tempo mepet kanan) → Customer →
 *   tabel bergaris putus-putus → [Inword/Remark/Transfer Via | Sincerely + penandatangan | ringkasan biaya].
 *
 * Nomor, cap, dan tanda tangan HANYA ada pada dokumen yang sudah diverifikasi (`approved`). Dokumen draft/menunggu
 * verifikasi diberi watermark besar "DRAFT" di atas isi, tanpa nomor, cap, dan tanda tangan.
 *
 * Komponen ini MURNI presentasi: seluruh teks & nominal sudah diformat di `document-data.ts` dari data tersimpan.
 * Font Times (bawaan PDF, tidak perlu di-embed) = padanan Times New Roman pada dokumen referensi.
 */

type Style = NonNullable<React.ComponentProps<typeof View>["style"]>;

export interface PdfImage { data: Buffer; format: "png" | "jpg" }

export interface InvoicePdfData {
  watermark: "DRAFT" | "DIBATALKAN" | null;
  /** true = sudah diverifikasi/diterbitkan → nomor, tanda tangan, dan cap boleh tampil. */
  approved: boolean;
  /** Peringatan singkat di kaki halaman (draft / dibatalkan). */
  disclaimer: string | null;
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

const s = StyleSheet.create({
  page: { paddingTop: 30, paddingBottom: 52, paddingHorizontal: 40, fontFamily: "Times-Roman", fontSize: 10.5, color: INK },
  // lineHeight sengaja BUKAN di Page: pada react-pdf, lineHeight tingkat-halaman membuat teks `render` (nomor halaman) berukuran nol.
  content: { lineHeight: "13pt" },
  bold: { fontFamily: "Times-Bold" },

  // Tiga kolom simetris (300 | fleksibel | 300) → judul tepat di tengah halaman, blok nomor menempel di tepi kanan.
  header: { flexDirection: "row" },
  brand: { flexDirection: "row", width: 300 },
  logo: { width: 62, height: 62, marginRight: 10 },
  brandText: { flex: 1 },
  companyName: { fontFamily: "Times-Bold", fontSize: 11.5 },
  tagline: { fontFamily: "Times-BoldItalic", marginBottom: 1 },
  kv: { flexDirection: "row" },
  kvLabel: { width: 36 },

  titleWrap: { flex: 1, alignItems: "center", paddingTop: 2 },
  title: { fontFamily: "Times-Bold", fontSize: 24, lineHeight: "28pt", textAlign: "center", letterSpacing: 2 },
  statusTag: { fontFamily: "Times-Bold", fontSize: 11, textAlign: "center", marginTop: 2 },

  // Blok nomor/tanggal: kotak sempit yang menempel di tepi kanan; nilai rata kanan sehingga sejajar dengan kolom "Nett Amount".
  metaWrap: { width: 300, alignItems: "flex-end" },
  metaBox: { width: 190 },
  metaLabel: { width: 76 },
  metaColon: { width: 8 },
  metaValue: { flex: 1, textAlign: "right" },

  customer: { flexDirection: "row", marginTop: 14, marginBottom: 6 },
  customerLabel: { width: 62 },

  tableHead: { flexDirection: "row", paddingVertical: 5, borderTopWidth: 1.6, borderBottomWidth: 1.6, borderStyle: "dashed", borderColor: INK },
  cNo: { width: 34 },
  cDesc: { flex: 1, paddingRight: 10 },
  cQty: { width: 90 },
  cPrice: { width: 118, textAlign: "right" },
  cNet: { width: 130, textAlign: "right" },
  row: { flexDirection: "row", paddingTop: 5 },
  rowNote: { fontFamily: "Times-Italic", fontSize: 9.5 },

  bottom: { flexDirection: "row", borderTopWidth: 1.6, borderStyle: "dashed", borderColor: INK, paddingTop: 5 },
  bottomLeft: { width: 292, paddingRight: 14 },
  bottomMid: { flex: 1, alignItems: "center" },
  bottomRight: { width: 236 },
  lr: { flexDirection: "row", marginBottom: 2 },
  lrLabel: { width: 50 },
  transfer: { marginTop: 8 },
  underline: { textDecoration: "underline", fontFamily: "Times-Bold" },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5 },
  sumRule: { borderBottomWidth: 1.6, borderStyle: "dashed", borderColor: INK, marginBottom: 3, paddingBottom: 3 },

  closing: { width: 190, alignItems: "center", height: 116, marginTop: 2 },
  stamp: { position: "absolute", top: 28, left: "50%", marginLeft: -62, width: 82, height: 82, opacity: 0.85 },
  signature: { position: "absolute", top: 28, left: "50%", marginLeft: -6, width: 64, height: 62 },
  signer: { position: "absolute", bottom: 0 },
  pending: { position: "absolute", bottom: 0, fontFamily: "Times-Italic", fontSize: 9.5, color: "#555555" },

  // Watermark digambar PALING AKHIR (di atas isi) agar tidak dapat tertutup elemen lain.
  watermark: {
    position: "absolute", top: 205, left: 0, right: 0, textAlign: "center", fontFamily: "Times-Bold",
    transform: "rotate(-24deg)", opacity: 0.14, letterSpacing: 8,
  },
  footer: { position: "absolute", left: 40, right: 150, bottom: 22, fontSize: 8.5, color: "#444444" },
  disclaimer: { fontFamily: "Times-Bold", fontSize: 8.5 },
  pageNo: { position: "absolute", right: 40, bottom: 22, width: 140, fontSize: 8.5, color: "#444444", textAlign: "right" },
});

/** Perkiraan tinggi blok total + penutup (pt) — ambang `minPresenceAhead` untuk baris terakhir. */
const TOTAL_BLOCK_HEIGHT = 190;
const MIN_BODY_HEIGHT = 56;
/** Perkiraan jumlah karakter per baris pada kolom deskripsi (landscape). */
const CHARS_PER_LINE = 78;
/** Baris setinggi lebih dari ini boleh terbelah antar halaman (deskripsi dinamis dengan banyak nama peserta). */
const MAX_UNBREAKABLE_LINES = 16;

const textLinesOf = (l: InvoicePdfData["lines"][number]) =>
  l.descriptionLines.reduce((n, d) => n + Math.max(1, Math.ceil(d.length / CHARS_PER_LINE)), 0) + (l.note ? 1 : 0);

/** Perkiraan tinggi baris untuk menghitung spacer (hanya kosmetik; kesalahan kecil tidak berdampak). */
function spacerHeight(lines: InvoicePdfData["lines"]): number {
  const used = lines.reduce((sum, l) => sum + textLinesOf(l) * 13.2 + 5, 0);
  return Math.max(0, MIN_BODY_HEIGHT - used);
}

/** Satu baris meta (label | ":" | nilai rata kanan). */
function MetaRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={s.kv}>
      <Text style={[s.metaLabel, bold ? s.bold : {}]}>{label}</Text>
      <Text style={[s.metaColon, bold ? s.bold : {}]}>:</Text>
      <Text style={[s.metaValue, bold ? s.bold : {}]}>{value}</Text>
    </View>
  );
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
  const wmColor = data.watermark === "DIBATALKAN" ? "#B3161F" : "#555555";
  return (
    <Document title={`Invoice ${data.meta.number}`} author={c.name} subject={`Invoice ${data.meta.number} — ${data.customerName}`} creator="Trilogika Invoice System" producer="Trilogika Invoice System">
      <Page size="A4" orientation="landscape" style={s.page}>
        <View style={s.content}>
        {/* ── Header: identitas | INVOICE (tengah) | nomor & tanggal (mepet kanan) ── */}
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
          <View style={s.titleWrap}>
            <Text style={s.title}>INVOICE</Text>
            {data.watermark && (
              <Text style={[s.statusTag, { color: data.watermark === "DIBATALKAN" ? "#B3161F" : "#444444" }]}>** {data.watermark} **</Text>
            )}
          </View>
          <View style={s.metaWrap}>
            <View style={s.metaBox}>
              <MetaRow label="Number" value={data.meta.number} bold />
              <MetaRow label="Inv. Date" value={data.meta.invoiceDate} />
              <MetaRow label="Payment Term" value={data.meta.paymentTerm} />
              <MetaRow label="Due Date" value={data.meta.dueDate} />
            </View>
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
              // Baris pendek tidak dipecah antar halaman; deskripsi sangat panjang (daftar peserta) boleh mengalir.
              wrap={textLinesOf(l) > MAX_UNBREAKABLE_LINES}
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

          {/* ── Inword/Remark/Transfer | Penutup & tanda tangan | Ringkasan (satu blok, tidak dipecah antar halaman) ── */}
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

              <View style={s.bottomMid}>
                <View style={s.closing}>
                  {/* Cap & tanda tangan hanya ada bila sudah diverifikasi; digambar LEBIH DULU agar teks tetap terbaca di atasnya. */}
                  {data.approved && c.stamp && <Image src={{ data: c.stamp.data, format: c.stamp.format }} style={s.stamp} />}
                  {data.approved && c.signature && <Image src={{ data: c.signature.data, format: c.signature.format }} style={s.signature} />}
                  <Text>{c.closingText}</Text>
                  <Text>{c.signerTitle}</Text>
                  {data.approved
                    ? <Text style={s.signer}>({c.signerName})</Text>
                    : <Text style={s.pending}>( menunggu verifikasi )</Text>}
                </View>
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
          </View>
        </View>

        </View>

        {(data.disclaimer || c.footerNote) && (
          <View fixed style={s.footer}>
            {data.disclaimer && <Text style={s.disclaimer}>{data.disclaimer}</Text>}
            {c.footerNote && <Text>{c.footerNote}</Text>}
          </View>
        )}
        {/* Selalu non-kosong: react-pdf mengukur kotak teks pada pass pertama (totalPages belum final). */}
        <Text fixed style={s.pageNo} render={({ pageNumber, totalPages }) => `Halaman ${pageNumber} / ${totalPages}`} />

        {data.watermark && (
          <Text fixed style={[s.watermark, { color: wmColor, fontSize: data.watermark === "DIBATALKAN" ? 92 : 150 }]}>{data.watermark}</Text>
        )}
      </Page>
    </Document>
  );
}
