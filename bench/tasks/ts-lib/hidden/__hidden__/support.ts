import assert from "node:assert/strict";

type Path = (string | number)[];
type AnySchema = { safeParse(input: unknown): unknown; parse(input: unknown): unknown };

/** The issues reported for `input`, normalised to plain { path, message } objects. */
export function issuesOf(schema: AnySchema, input: unknown): { path: Path; message: string }[] {
  const r = schema.safeParse(input) as { success: boolean; error?: { issues: { path: Path; message: string }[] } };
  assert.equal(r.success, false, `expected ${String(input)} to be rejected`);
  return r.error!.issues.map((i) => ({ path: [...i.path], message: i.message }));
}

export function ok(schema: AnySchema, input: unknown): unknown {
  const r = schema.safeParse(input) as { success: boolean; data?: unknown; error?: { message: string } };
  assert.equal(r.success, true, `expected ${String(input)} to be accepted: ${r.error?.message}`);
  return r.data;
}

export function one(path: Path, message: string) {
  return [{ path, message }];
}
