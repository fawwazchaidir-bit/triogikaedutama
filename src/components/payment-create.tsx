"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { RecordPaymentDialog, type PayableInvoice } from "@/components/record-payment-dialog";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";
import type { InvoiceListItemDto, Paged } from "@/lib/types";

/** Tombol "Catat pembayaran" di halaman Pembayaran: pilih invoice terbit yang masih memiliki sisa tagihan. */
export function PaymentCreate() {
  const router = useRouter();
  const toast = useToast();
  const [pick, setPick] = useState(false);
  const [text, setText] = useState("");
  const [inv, setInv] = useState<PayableInvoice | null>(null);
  const [pay, setPay] = useState(false);

  return (
    <>
      <Button variant="primary" onClick={() => { setText(""); setInv(null); setPick(true); }}><Plus className="size-4" />Catat pembayaran</Button>
      <Dialog open={pick} onClose={() => setPick(false)} title="Pilih invoice" description="Hanya invoice terbit dengan sisa tagihan yang ditampilkan." size="md">
        <Field label="Nomor invoice atau pelanggan" htmlFor="pick-inv">
          <Combobox<InvoiceListItemDto>
            ariaLabel="Cari invoice" value={text} onValueChange={setText} placeholder="mis. 00435 atau nama pelanggan…"
            search={async (q) => (await api<Paged<InvoiceListItemDto>>(`/api/invoices?status=ISSUED&q=${encodeURIComponent(q)}&pageSize=20&sort=due&dir=asc`)).items.filter((i) => i.balanceAmount > 0)}
            itemKey={(i) => i.id} emptyText="Tidak ada invoice dengan sisa tagihan"
            renderItem={(i) => <div className="flex items-baseline justify-between gap-3"><span><span className="font-mono font-semibold">{i.number}</span> · {i.customerName}</span><span className="tabular text-xs text-muted">sisa {formatRupiah(i.balanceAmount, "PLAIN")}</span></div>}
            onSelect={(i) => { setInv({ id: i.id, number: i.number, customerName: i.customerName, balanceAmount: i.balanceAmount }); setPick(false); setPay(true); }}
          />
        </Field>
      </Dialog>
      <RecordPaymentDialog open={pay} onClose={() => setPay(false)} invoice={inv} onDone={() => { setPay(false); toast.success("Pembayaran dicatat."); router.refresh(); }} />
    </>
  );
}
