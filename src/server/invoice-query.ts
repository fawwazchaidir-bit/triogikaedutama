import "server-only";
import { z } from "zod";
import { isoDate } from "@/lib/validation/common";

/** Skema query daftar invoice — dipakai API, halaman server, dan ekspor (satu definisi filter). */
export const invoiceListQuerySchema = z.object({
  q: z.string().max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  customerId: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "ISSUED", "CANCELLED"]).optional(),
  paymentStatus: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID", "OVERDUE"]).optional(),
  createdById: z.string().uuid().optional(),
  sort: z.enum(["date", "total", "due", "number"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});
