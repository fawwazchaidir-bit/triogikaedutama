"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumberId, formatRupiah } from "@/lib/finance/money";
import { monthLabel } from "@/lib/format";

/**
 * Grafik kolom berkelompok: Nilai invoice terbit vs Penerimaan kas per bulan.
 * Satu sumbu (tidak ada dual-axis). Dua seri → legenda wajib. Palet divalidasi (validate_palette.js):
 * biru #2a78d6 / oranye #eb6834 — lulus CVD & kontras. Tooltip & tampilan tabel menjamin nilai tak bergantung hover.
 */
export interface TrendPoint { month: string; invoiced: number; received: number }

const SERIES = [
  { key: "invoiced", label: "Nilai invoice terbit", color: "#2a78d6" },
  { key: "received", label: "Penerimaan kas", color: "#eb6834" },
] as const;

function compact(n: number): string {
  if (n >= 1_000_000_000) return `${+(n / 1_000_000_000).toFixed(1)} M`;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)} jt`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(0)} rb`;
  return String(n);
}

function niceMax(v: number): number {
  if (v <= 0) return 1_000_000;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 280;
  const m = { top: 12, right: 12, bottom: 34, left: 56 };
  const innerW = width - m.left - m.right;
  const innerH = H - m.top - m.bottom;
  const max = useMemo(() => niceMax(Math.max(0, ...data.flatMap((d) => [d.invoiced, d.received]))), [data]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const band = data.length ? innerW / data.length : innerW;
  const barW = Math.min(24, Math.max(6, (band - 14) / 2 - 1));
  const y = (v: number) => m.top + innerH - (v / max) * innerH;
  const showEvery = Math.ceil(data.length / Math.max(1, Math.floor(innerW / 54)));
  const hasData = data.some((d) => d.invoiced || d.received);

  const bar = (x: number, v: number, color: string, dim: boolean) => {
    if (v <= 0) return null;
    const h = Math.max(2, innerH - (y(v) - m.top));
    const r = Math.min(4, barW / 2, h);
    const top = m.top + innerH - h;
    // Kolom: ujung data membulat 4px, dasar rata (menempel pada baseline).
    return (
      <path
        d={`M${x},${m.top + innerH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${m.top + innerH} Z`}
        fill={color} opacity={dim ? 0.45 : 1}
      />
    );
  };

  const a = active !== null ? data[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(m.left + band * active + band / 2 - 90, 4), width - 190) : 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-soft" aria-label="Legenda">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span aria-hidden className="inline-block size-3 rounded-[3px]" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setTable((t) => !t)} aria-pressed={table} className="rounded-md border border-line bg-white px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-canvas">
          {table ? "Tampilkan grafik" : "Tampilkan tabel"}
        </button>
      </div>

      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <caption className="sr-only">Nilai invoice terbit dan penerimaan kas per bulan</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-4">Bulan</th>
                <th scope="col" className="py-2 pr-4 text-right">Nilai invoice terbit</th>
                <th scope="col" className="py-2 text-right">Penerimaan kas</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.month} className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">{monthLabel(d.month)}</th>
                  <td className="tabular py-2 pr-4 text-right">{formatRupiah(d.invoiced, "PLAIN")}</td>
                  <td className="tabular py-2 text-right">{formatRupiah(d.received, "PLAIN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="relative">
          <svg width={width} height={H} role="img" aria-label={`Grafik kolom nilai invoice terbit dan penerimaan kas per bulan, ${data.length} bulan`} onPointerLeave={() => setActive(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke="#e4e1dc" strokeWidth={1} />
                <text x={m.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#6b6760">{compact(t)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = m.left + band * i + band / 2;
              const dim = active !== null && active !== i;
              return (
                <g key={d.month}>
                  {bar(cx - barW - 1, d.invoiced, SERIES[0].color, dim)}
                  {bar(cx + 1, d.received, SERIES[1].color, dim)}
                  {i % showEvery === 0 && (
                    <text x={cx} y={H - 12} textAnchor="middle" fontSize={11} fill="#6b6760">{monthLabel(d.month, true).replace(/ \d{4}$/, "")}{data.length > 12 && d.month.endsWith("-01") ? ` ’${d.month.slice(2, 4)}` : ""}</text>
                  )}
                  {/* Area sentuh sebesar seluruh pita bulan (lebih besar dari tanda), juga fokus keyboard. */}
                  <rect
                    x={m.left + band * i} y={m.top} width={band} height={innerH + 22} fill="transparent" tabIndex={0}
                    aria-label={`${monthLabel(d.month)}: nilai invoice ${formatRupiah(d.invoiced, "PLAIN")}, penerimaan kas ${formatRupiah(d.received, "PLAIN")}`}
                    onPointerEnter={() => setActive(i)} onPointerMove={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                  />
                </g>
              );
            })}
            <line x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke="#c9c5bd" strokeWidth={1} />
          </svg>
          {a && (
            <div role="status" className="pointer-events-none absolute top-2 z-10 w-[180px] rounded-md border border-line bg-white p-2.5 text-xs shadow-lg" style={{ left: tipLeft }}>
              <p className="mb-1.5 font-medium text-ink-soft">{monthLabel(a.month)}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="flex items-center gap-1.5 text-muted"><span aria-hidden className="inline-block h-0.5 w-3" style={{ background: s.color }} />{s.label.replace(" terbit", "")}</span>
                  <span className="tabular font-semibold text-ink">{formatNumberId(a[s.key])}</span>
                </p>
              ))}
            </div>
          )}
          {!hasData && <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-muted">Belum ada data pada periode ini.</p>}
        </div>
      )}
    </div>
  );
}
