import { s } from "../../src/index.ts";

declare const input: unknown;

const str: string = s.string().min(1).trim().parse(input);
const num: number = s.number().int().positive().parse(input);
const bool: boolean = s.boolean().parse(input);
const lit: "admin" = s.literal("admin").parse(input);
const fortyTwo: 42 = s.literal(42).parse(input);
const color: "red" | "green" = s.enum(["red", "green"]).parse(input);

// @ts-expect-error a string schema does not produce numbers
const wrong1: number = s.string().parse(input);
// @ts-expect-error a number schema does not produce strings
const wrong2: string = s.number().max(3).parse(input);
// @ts-expect-error literal types are kept precise
const wrong3: "member" = s.literal("admin").parse(input);
// @ts-expect-error enum output is the union of its values, not just one of them
const wrong4: "red" = s.enum(["red", "green"]).parse(input);
// @ts-expect-error enum output is not a plain string-accepting type
const wrong5: "red" | "green" = s.enum(["red", "green", "blue"]).parse(input);

export { str, num, bool, lit, fortyTwo, color, wrong1, wrong2, wrong3, wrong4, wrong5 };
