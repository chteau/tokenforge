import { s, type Infer } from "../../src/index.ts";

const Order = s.object({
  id: s.string(),
  lines: s.array(
    s.object({
      sku: s.string(),
      qty: s.number().int().default(1),
      note: s.string().optional(),
    }),
  ),
  customer: s.object({ name: s.string(), vip: s.boolean().optional() }),
});
type Order = Infer<typeof Order>;

const order: Order = { id: "o1", lines: [{ sku: "a", qty: 2 }], customer: { name: "Ada" } };
const firstSku: string = order.lines[0]!.sku;

const bad1: Order = {
  id: "o1",
  // @ts-expect-error qty must be a number
  lines: [{ sku: "a", qty: "2" }],
  customer: { name: "Ada" },
};
const bad2: Order = {
  id: "o1",
  lines: [],
  // @ts-expect-error customer.name is required
  customer: { vip: true },
};

export { order, firstSku, bad1, bad2 };
