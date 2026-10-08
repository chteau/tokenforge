import { s } from "../../src/index.ts";

declare const input: unknown;

const opt: string | undefined = s.string().optional().parse(input);
const nul: number | null = s.number().nullable().parse(input);
const def: string = s.string().default("x").parse(input);
const optDef: string = s.string().optional().default("x").parse(input);
const both: boolean | null | undefined = s.boolean().nullable().optional().parse(input);
const refined: number = s.number().refine((n) => n.toFixed(0) === "1").parse(input);
const refinedObj = s.object({ a: s.string() }).refine((o) => o.a.length > 0, "empty").parse(input);
const a: string = refinedObj.a;

// @ts-expect-error optional output may be undefined
const opt2: string = s.string().optional().parse(input);
// @ts-expect-error nullable output may be null
const nul2: number = s.number().nullable().parse(input);
// @ts-expect-error default value must match the schema type
s.number().default("3");
// @ts-expect-error refine callback receives the parsed type
s.string().refine((v) => v.toFixed(0) === "1");

export { opt, nul, def, optDef, both, refined, a, opt2, nul2 };
