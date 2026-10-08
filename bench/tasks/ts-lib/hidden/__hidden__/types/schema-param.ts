import { s, type Infer, type Schema } from "../../src/index.ts";

function parseWith<T>(schema: Schema<T>, value: unknown): T {
  return schema.parse(value);
}
function onlyStrings(schema: Schema<string>): Schema<string> {
  return schema;
}

const n: number = parseWith(s.number().int(), 1);
const list: boolean[] = parseWith(s.array(s.boolean()), []);
onlyStrings(s.string().email());
onlyStrings(s.enum(["a", "b"]));
const inferred: Infer<ReturnType<typeof s.string>> = "x";

// @ts-expect-error a number schema is not a string schema
onlyStrings(s.number());
// @ts-expect-error an optional string schema can produce undefined
onlyStrings(s.string().optional());

export { n, list, inferred };
