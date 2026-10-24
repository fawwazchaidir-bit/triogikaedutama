import { z } from "zod";
import { readJson, route } from "@/server/http";
import { getCustomer, setCustomerActive, updateCustomer } from "@/server/services/customers";
import { uuid } from "@/lib/validation/common";

type P = { id: string };
export const GET = route<P>(({ actor, params }) => getCustomer(actor, uuid.parse(params.id)));
export const PUT = route<P>(async ({ req, actor, params }) => updateCustomer(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
export const PATCH = route<P>(async ({ req, actor, params }) => {
  const { isActive } = await readJson(req, z.object({ isActive: z.boolean() }));
  return setCustomerActive(actor, uuid.parse(params.id), isActive);
});
