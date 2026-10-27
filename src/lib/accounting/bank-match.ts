/**
 * Pencocokan rekening koran ↔ transaksi buku — fungsi MURNI.
 * Selisih rekonsiliasi = saldo akhir bank + transaksi buku yang BELUM dicocokkan (≤ akhir periode) − saldo buku pada akhir periode. Nol = cocok.
 */
export type BookItemType = "PAYMENT" | "CASH_ENTRY" | "TRANSFER";
export interface BookItem { type: BookItemType; id: string; date: string; createdAt: string; /** BERTANDA pada akun ini */ amount: number; label: string; /** teks pencarian (no. invoice, referensi, nama) */ hint: string }
export const itemKey = (i: { type: string; id: string }) => `${i.type}:${i.id}`;
export interface MatchLine { id: string; date: string; amount: number; description: string; reference: string | null; /** Σ nilai yang sudah dicocokkan */ matched: number }

const dayNum = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);

/** Skor teks 0/1: ada token (≥ 4 huruf/angka) dari petunjuk transaksi yang muncul pada uraian/referensi mutasi. */
export function textScore(line: Pick<MatchLine, "description" | "reference">, item: Pick<BookItem, "hint">): number {
  const hay = `${line.description} ${line.reference ?? ""}`.toLowerCase();
  return tokens(item.hint).some((t) => hay.includes(t)) ? 1 : 0;
}

/**
 * Usulan pencocokan 1-ke-1: nilai sama persis (sisa baris = nilai transaksi) dan selisih tanggal ≤ `windowDays`.
 * Hanya yang TIDAK ambigu: bila dua kandidat sama bagusnya (selisih hari & skor teks sama) untuk satu baris — atau dua baris berebut satu transaksi — dilewati (manual).
 */
export function suggestMatches(lines: MatchLine[], items: BookItem[], windowDays = 5): { lineId: string; item: BookItem }[] {
  type Pair = { line: MatchLine; item: BookItem; diff: number; score: number };
  const pairs: Pair[] = [];
  for (const line of lines) {
    const remaining = line.amount - line.matched;
    if (remaining === 0) continue;
    for (const item of items) {
      if (item.amount !== remaining) continue;
      const diff = Math.abs(dayNum(line.date) - dayNum(item.date));
      if (diff <= windowDays) pairs.push({ line, item, diff, score: textScore(line, item) });
    }
  }
  const better = (a: Pair, b: Pair) => b.score - a.score || a.diff - b.diff; // <0: a lebih baik
  const bestFor = <K,>(key: (p: Pair) => K) => {
    const groups = new Map<K, Pair[]>();
    for (const p of pairs) { const k = key(p); (groups.get(k) ?? groups.set(k, []).get(k)!).push(p); }
    const out = new Map<K, Pair | null>();
    for (const [k, ps] of groups) { const s = [...ps].sort(better); out.set(k, s.length > 1 && better(s[0]!, s[1]!) === 0 ? null : s[0]!); }
    return out;
  };
  const byLine = bestFor((p) => p.line.id), byItem = bestFor((p) => itemKey(p.item));
  const result: { lineId: string; item: BookItem }[] = [];
  for (const [lineId, p] of byLine) {
    if (!p) continue;
    if (byItem.get(itemKey(p.item)) === p) result.push({ lineId, item: p.item });
  }
  return result;
}

export interface ReconSummary { closing: number; outstandingNet: number; adjustedBank: number; bookBalance: number; difference: number }
export function reconSummary(closing: number, bookBalance: number, outstanding: Pick<BookItem, "amount">[]): ReconSummary {
  const outstandingNet = outstanding.reduce((s, i) => s + i.amount, 0);
  const adjustedBank = closing + outstandingNet;
  return { closing, outstandingNet, adjustedBank, bookBalance, difference: adjustedBank - bookBalance };
}
