import { Document, Font, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReportColumn, ReportTable } from "../export";

/**
 * PDF laporan keuangan (laba rugi, neraca, arus kas, neraca saldo, buku besar): satu templat untuk semua laporan, dibangun dari `ReportTable`
 * yang sama dengan CSV/Excel sehingga angka di layar, Excel, dan PDF identik. Potret untuk ≤ 4 kolom, lanskap bila lebih lebar (buku besar, pembanding).
 * Font bawaan PDF (Helvetica): simbol di luar WinAnsi diganti ekuivalen teks oleh `pdfSafe`.
 */
Font.registerHyphenationCallback((word) => [word]);

export interface ReportPdfData { companyName: string; table: ReportTable; printedBy: string; printedAt: string }

const SAFE: Record<string, string> = { "→": "->", "←": "<-", "✓": "", "−": "-", "≤": "<=", "≥": ">=", "≠": "!=", "×": "x", "…": "...", "⚠": "!" };
/** Ganti simbol yang tidak ada di Helvetica/WinAnsi; karakter lain di luar Latin-1 dibuang agar PDF tidak berisi kotak kosong. */
export function pdfSafe(text: string): string {
  return text.replace(/[^\u0000-ÿ–—‘’“”•€]/g, (ch) => SAFE[ch] ?? "").replace(/ {2,}/g, " ").trim();
}

const NUM = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const ISO = /^\d{4}-\d{2}-\d{2}/;
const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
function cell(v: string | number | null | undefined, col: ReportColumn): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return NUM.format(v);
  if (col.type === "date" && ISO.test(v)) return fmtDate(v); // sel "TOTAL" di kolom tanggal tetap teks
  return pdfSafe(v);
}

const INK = "#1c1917";
const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 64, paddingHorizontal: 36, fontFamily: "Helvetica", fontSize: 9, color: INK },
  content: { lineHeight: "12pt" },
  company: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 14, marginTop: 2 },
  period: { marginTop: 4, color: "#57534e" },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 3, marginTop: 10, fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", paddingVertical: 1.5 },
  bold: { fontFamily: "Helvetica-Bold" },
  totalRow: { borderTopWidth: 0.7, borderTopColor: INK, marginTop: 1, paddingTop: 2 },
  headKind: { marginTop: 6, fontFamily: "Helvetica-Bold" },
  noteKind: { fontFamily: "Helvetica-Oblique", fontSize: 8, color: "#57534e" },
  ruled: { borderBottomWidth: 0.4, borderBottomColor: "#d6d3d1" },
  footer: { position: "absolute", left: 36, right: 36, bottom: 24, fontSize: 7, color: "#57534e" },
  footerLine: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 },
});

export function ReportPdf({ data }: { data: ReportPdfData }) {
  const { table: t } = data;
  const landscape = t.columns.length >= 5;
  const total = t.columns.reduce((a, c) => a + (c.width ?? 20), 0);
  const w = (c: ReportColumn) => `${(((c.width ?? 20) / total) * 100).toFixed(2)}%`;
  const right = (c: ReportColumn) => c.type === "money" || c.type === "number";
  const statement = t.rows.some((r) => typeof r.kind === "string"); // laporan berstruktur (judul/jumlah/catatan) vs tabel biasa

  return (
    <Document title={pdfSafe(t.title)} author={pdfSafe(data.companyName)} creator="Trilogika Invoice System">
      <Page size="A4" orientation={landscape ? "landscape" : "portrait"} style={s.page}>
        <View style={s.content}>
          <View fixed>
            <Text style={s.company}>{pdfSafe(data.companyName)}</Text>
            <Text style={s.title}>{pdfSafe(t.title)}</Text>
            <Text style={s.period}>{pdfSafe(t.periodLabel)}{t.compareLabel ? `  |  Pembanding: ${pdfSafe(t.compareLabel)}` : ""}</Text>
            <View style={s.headRow}>
              {t.columns.map((c) => <Text key={c.key} style={{ width: w(c), textAlign: right(c) ? "right" : "left", paddingRight: 4 }}>{pdfSafe(c.label)}</Text>)}
            </View>
          </View>
          {t.rows.map((r, i) => {
            const kind = r.kind as string | undefined;
            const indent = kind === "line" || (statement && kind === undefined) ? 10 : 0;
            return (
              <View key={i} wrap={false} style={[s.row, !statement ? s.ruled : {}, kind === "head" ? s.headKind : {}, kind === "total" ? [s.bold, s.totalRow] : {}, kind === "note" ? s.noteKind : {}]}>
                {t.columns.map((c, ci) => (
                  <Text key={c.key} style={{ width: w(c), textAlign: right(c) ? "right" : "left", paddingRight: 4, paddingLeft: ci === 0 ? indent : 0 }}>
                    {cell(r[c.key], c).replace(/^\s+/, "")}
                  </Text>
                ))}
              </View>
            );
          })}
          {t.totals && (
            <View wrap={false} style={[s.row, s.bold, s.totalRow]}>
              {t.columns.map((c, ci) => <Text key={c.key} style={{ width: w(c), textAlign: right(c) ? "right" : "left", paddingRight: 4 }}>{ci === 0 && t.totals![c.key] == null ? "TOTAL" : cell(t.totals![c.key], c)}</Text>)}
            </View>
          )}
        </View>
        <View style={s.footer} fixed>
          <Text>{pdfSafe(t.disclaimer)}</Text>
          <View style={s.footerLine}>
            <Text>Dicetak {pdfSafe(data.printedAt)} oleh {pdfSafe(data.printedBy)}</Text>
            <Text render={({ pageNumber, totalPages }) => `Halaman ${pageNumber} dari ${totalPages}`} />
          </View>
        </View>
      </Page>
    </Document>
  );
}
