import { s, ValidationError, type Issue, type SafeParseResult } from "../../src/index.ts";

declare const input: unknown;

const r = s.object({ n: s.number() }).safeParse(input);
let n = 0;
let issues: Issue[] = [];
if (r.success) {
  n = r.data.n;
} else {
  const e: ValidationError = r.error;
  issues = e.issues;
  const first: string = issues[0]!.message;
  const path: (string | number)[] = issues[0]!.path;
  void first;
  void path;
}

const typed: SafeParseResult<string> = s.string().safeParse(input);

// @ts-expect-error data is only available after checking success
const d = r.data;
// @ts-expect-error result type follows the schema
const wrong: SafeParseResult<number> = s.string().safeParse(input);

export { n, issues, typed, d, wrong };
