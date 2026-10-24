import { z } from "zod";
import { readJson, route } from "@/server/http";
import { updateProduct } from "@/server/services/products";
import { uuid } from "@/lib/validation/common";

export const PUT = route<{ id: string }>(async ({ req, actor, params }) => updateProduct(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
