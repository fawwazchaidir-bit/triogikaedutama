/**
 * Pembanding periode untuk laporan keuangan — fungsi MURNI (tanpa IO).
 *  • `comparativeRange`: periode pembanding untuk rentang (laba rugi, arus kas) atau tanggal posisi (neraca).
 *  • `mergeComparative`: menggabungkan baris laporan periode berjalan dan pembanding berdasarkan uraian baris, dengan urutan tetap
 *    (baris yang hanya ada di pembanding disisipkan setelah baris sebelumnya yang sudah ada).
 */
export type CompareMode = "none" | "previous" | "year";
export type RowKind = "head" | "line" | "total" | "note";

export interface BaseRow { item: string; amount: number | null; kind: RowKind }
export interface MergedRow extends BaseRow { prev: number | null; change: number | null; /** perubahan dalam persen × 100 (basis poin), null bila pembanding 0/kosong */ changeBps: number | null }

const DAY = 86_400_000;
const parse = (iso: string) => { const [y, m, d] = iso.split("-").map(Number) as [number, number, number]; return { y, m, d }; };
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
const ts = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isMonthStart = (iso: string) => parse(iso).d === 1;
const isMonthEnd = (iso: string) => { const { y, m, d } = parse(iso); return d === daysInMonth(y, m); };

/** Geser bulan dengan menjaga akhir bulan (31 Mar − 1 bulan = 28/29 Feb). */
export function addMonths(iso: string, delta: number): string {
  const { y, m, d } = parse(iso);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  return fmt(Date.UTC(ny, nm - 1, Math.min(d, daysInMonth(ny, nm))));
}

/**
 * Rentang pembanding.
 *  - `range` (laba rugi, arus kas): "previous" = periode sama panjang tepat sebelumnya — bila rentang utuh bulan kalender (1 s.d. akhir bulan)
 *    dipakai jumlah bulan yang sama (Okt vs Sep, bukan 31 hari mundur); selain itu jumlah hari yang sama. "year" = tanggal yang sama setahun lalu.
 *  - `asof` (neraca): "previous" = hari sebelum `from` (akhir periode sebelumnya); "year" = `to` setahun lalu.
 */
export function comparativeRange(kind: "range" | "asof", from: string, to: string, mode: Exclude<CompareMode, "none">): { from: string; to: string } {
  if (mode === "year") {
    const pf = addMonths(from, -12);
    const pt = isMonthEnd(to) ? fmt(Date.UTC(parse(to).y - 1, parse(to).m, 0)) : addMonths(to, -12);
    return { from: pf, to: pt };
  }
  const prevTo = fmt(ts(from) - DAY);
  if (kind === "asof") return { from: prevTo, to: prevTo };
  if (isMonthStart(from) && isMonthEnd(to)) {
    const a = parse(from), b = parse(to);
    const months = (b.y * 12 + b.m) - (a.y * 12 + a.m) + 1;
    return { from: addMonths(from, -months), to: prevTo };
  }
  const len = Math.round((ts(to) - ts(from)) / DAY) + 1;
  return { from: fmt(ts(prevTo) - (len - 1) * DAY), to: prevTo };
}

export function changeOf(cur: number | null, prev: number | null): { change: number | null; changeBps: number | null } {
  if (cur === null || prev === null) return { change: null, changeBps: null };
  const change = cur - prev;
  return { change, changeBps: prev === 0 ? null : Math.round((change * 10_000) / Math.abs(prev)) };
}

/** Gabungkan dua daftar baris (kunci = uraian). Urutan periode berjalan dipertahankan. */
export function mergeComparative(cur: BaseRow[], prev: BaseRow[]): MergedRow[] {
  const out: MergedRow[] = cur.map((r) => ({ ...r, prev: null, change: null, changeBps: null }));
  const index = new Map(out.map((r, i) => [r.item, i]));
  const prevByItem = new Map(prev.map((r) => [r.item, r]));
  for (const r of out) { const p = prevByItem.get(r.item); r.prev = p ? p.amount : r.amount === null ? null : 0; } // baris yang tidak ada di pembanding bernilai 0
  let lastPos = -1;
  prev.forEach((p, j) => {
    const at = index.get(p.item);
    if (at !== undefined) { lastPos = out.findIndex((r) => r.item === p.item); return; }
    // baris hanya ada di pembanding → sisipkan setelah baris pembanding sebelumnya (atau di awal)
    const insertAt = j === 0 ? 0 : lastPos + 1;
    out.splice(insertAt, 0, { item: p.item, kind: p.kind, amount: p.amount === null ? null : 0, prev: p.amount, change: null, changeBps: null });
    index.clear(); out.forEach((r, i) => index.set(r.item, i));
    lastPos = insertAt;
  });
  for (const r of out) { const c = changeOf(r.amount, r.prev); r.change = c.change; r.changeBps = c.changeBps; }
  return out;
}
