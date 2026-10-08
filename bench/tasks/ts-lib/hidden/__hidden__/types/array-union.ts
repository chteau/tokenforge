import { s, type Infer } from "../../src/index.ts";

declare const input: unknown;

const tags: string[] = s.array(s.string()).min(1).max(3).parse(input);
const matrix: number[][] = s.array(s.array(s.number())).parse(input);
const id: string | number = s.union([s.string(), s.number()]).parse(input);

const Shape = s.union([
  s.object({ kind: s.literal("circle"), r: s.number() }),
  s.object({ kind: s.literal("square"), side: s.number() }),
]);
type Shape = Infer<typeof Shape>;
const shape: Shape = { kind: "circle", r: 1 };
function area(x: Shape): number {
  return x.kind === "circle" ? x.r * x.r * 3 : x.side * x.side;
}

// @ts-expect-error element type is preserved
const tags2: number[] = s.array(s.string()).parse(input);
// @ts-expect-error union output includes number
const id2: string = s.union([s.string(), s.number()]).parse(input);
// @ts-expect-error a circle has no side
const bad: Shape = { kind: "circle", side: 1 };

export { tags, matrix, id, shape, area, tags2, id2, bad };
