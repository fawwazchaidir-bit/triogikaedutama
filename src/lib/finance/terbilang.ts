/**
 * Terbilang bahasa Indonesia — fungsi deterministik (TANPA AI generatif), mudah diuji.
 *
 *   14000000 → "Empat Belas Juta Rupiah"
 *   2500000  → "Dua Juta Lima Ratus Ribu Rupiah"
 *   1000000  → "Satu Juta Rupiah"
 *   0        → "Nol Rupiah"
 *
 * Aturan tata bahasa yang ditangani:
 *  - 1 di posisi ratusan/ribuan murni → "seratus" / "seribu" (bukan "satu ratus" / "satu ribu"),
 *    tetapi "satu juta", "satu miliar", "satu triliun".
 *  - 11 → "sebelas", 12–19 → "dua belas" … "sembilan belas", 20–99 → "dua puluh satu" dst.
 *  - Kelompok bernilai nol dilewati (1.000.001 → "Satu Juta Satu", bukan "Satu Juta Nol Ribu Satu").
 *  - Desimal (opsional): "Seribu Dua Ratus Koma Lima Enam Rupiah".
 */

const ONES = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"];
const SCALES = ["", "ribu", "juta", "miliar", "triliun", "kuadriliun"];

/** Terbilang untuk 0–999 (huruf kecil, tanpa satuan skala). */
function below1000(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 1) parts.push("seratus");
  else if (hundreds > 1) parts.push(`${ONES[hundreds]} ratus`);

  if (rest >= 20) {
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    parts.push(`${ONES[tens]} puluh`);
    if (ones > 0) parts.push(ONES[ones] as string);
  } else if (rest === 11) {
    parts.push("sebelas");
  } else if (rest === 10) {
    parts.push("sepuluh");
  } else if (rest > 10) {
    parts.push(`${ONES[rest - 10]} belas`);
  } else if (rest > 0) {
    parts.push(ONES[rest] as string);
  }
  return parts.join(" ");
}

function integerWords(value: bigint): string {
  if (value === 0n) return "nol";
  const groups: number[] = [];
  let rest = value;
  while (rest > 0n) {
    groups.push(Number(rest % 1000n));
    rest /= 1000n;
  }
  if (groups.length > SCALES.length) {
    throw new RangeError("Nominal terlalu besar untuk terbilang");
  }
  const out: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as number;
    if (g === 0) continue;
    if (i === 1 && g === 1) out.push("seribu"); // 1.000–1.999 → "seribu"
    else out.push(i === 0 ? below1000(g) : `${below1000(g)} ${SCALES[i]}`);
  }
  return out.join(" ");
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/**
 * @param amount  bilangan bulat (number/bigint) atau string desimal "1234.56" / "1234,56" (opsional).
 * @param currency satuan akhir; default "Rupiah".
 */
export function terbilang(amount: number | bigint | string, currency = "Rupiah"): string {
  let negative = false;
  let intPart: bigint;
  let fraction = "";

  if (typeof amount === "string") {
    const m = /^(-)?(\d+)(?:[.,](\d+))?$/.exec(amount.trim());
    if (!m) throw new RangeError("Format nominal tidak valid untuk terbilang");
    negative = Boolean(m[1]);
    intPart = BigInt(m[2] as string);
    fraction = (m[3] ?? "").replace(/0+$/, "");
  } else if (typeof amount === "bigint") {
    negative = amount < 0n;
    intPart = negative ? -amount : amount;
  } else {
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
      throw new RangeError("Gunakan string untuk nominal desimal");
    }
    negative = amount < 0;
    intPart = BigInt(Math.abs(amount));
  }

  let words = integerWords(intPart);
  if (fraction) {
    words += ` koma ${fraction
      .split("")
      .map((d) => (d === "0" ? "nol" : (ONES[Number(d)] as string)))
      .join(" ")}`;
  }
  const isZero = intPart === 0n && !fraction;
  const text = `${negative && !isZero ? "minus " : ""}${words} ${currency.toLowerCase()}`;
  return titleCase(text);
}
