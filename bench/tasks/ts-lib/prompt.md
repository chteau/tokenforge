Build **Ward**, a small, typed schema validation library for TypeScript, from scratch in this repository (it currently contains only a README). Think of a tiny subset of zod: you describe the shape of some data with schemas, then `parse` unknown input against them and get either a typed value or precise error messages.

## Project requirements

- **Zero runtime dependencies** and no npm packages at all (there is no network access; nothing can be installed). A global `tsc` (TypeScript) is available, and Node.js runs `.ts` files directly through its built-in type stripping.
- **Erasable TypeScript syntax only**, so the code runs unmodified under Node's type stripping: no `enum`, no `namespace`, no constructor parameter properties (`constructor(private x: T)`), no `import x = require(...)`.
- **ESM** with explicit `.ts` extensions in relative imports (`import { x } from "./other.ts"`). `package.json` must have `"type": "module"` and no `dependencies`.
- The public API is exported from **`src/index.ts`**. Split the implementation into several modules under `src/` (do not put everything in one file).
- A **`tsconfig.json`** at the repository root with at least these compiler options: `"strict": true`, `"noEmit": true`, `"allowImportingTsExtensions": true`, `"erasableSyntaxOnly": true`, `"module": "nodenext"`, `"moduleResolution": "nodenext"`, `"target": "es2024"`, `"lib": ["es2024"]`, `"types": []`. `tsc --noEmit -p .` must exit 0 and must cover everything in `src/`. (There is no `@types/node`: if you also type-check your test files, add a small ambient declaration for the `node:` modules they use, or leave tests out of `include`.)
- No `any` in the public API: the exported types and signatures (as they would appear in emitted `.d.ts` files) must not contain `any`; use `unknown` and generics instead.
- Add tests (`*.test.ts` files, e.g. under `test/`) that run with `node --test` and pass.

Your library is checked automatically by tests that import `src/index.ts` and by type-level tests compiled with `tsc` in strict mode, so names, messages and paths below must match **exactly**.

## Public API (`src/index.ts`)

```ts
export const s: { string, number, boolean, literal, enum, object, array, union };  // schema builders
export class ValidationError extends Error { issues: Issue[] }
export function formatPath(path: readonly (string | number)[]): string;
export type Issue = { path: (string | number)[]; message: string };
export type Schema<T> = ...;          // any schema whose parsed output type is T (an exported class or interface)
export type Infer<S> = ...;           // the output type of schema S
export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: ValidationError };
```

Every schema has these methods:

- `parse(input: unknown): T` — returns the parsed value or throws a `ValidationError`.
- `safeParse(input: unknown): SafeParseResult<T>` — never throws; returns exactly `{ success: true, data }` or `{ success: false, error }` (no other properties).
- `optional()`, `nullable()`, `default(value)`, `refine(check, message?)` — see *Modifiers*.

Schemas are **immutable**: every method returns a new schema and never changes the one it is called on. Parsing never mutates the input; objects and arrays in the output are new objects/arrays.

## Issues and errors

- An `Issue` is a plain object with exactly two properties: `path` (array of object keys and array indices leading to the bad value; `[]` for the root) and `message`.
- Validation **collects all issues**, it does not stop at the first one. Order: object properties in the order of the shape definition, array elements by index, and for a single value its checks in the order the methods were chained (details below).
- `ValidationError`: `name` is `"ValidationError"`, `issues` is the non-empty list of issues, `instanceof Error` and `instanceof ValidationError` both hold, and `message` is every issue formatted as `<formatPath(path)>: <message>`, joined with `"\n"`.
- `formatPath(path)`: `[]` → `(root)`; string segments are joined with `.`; number segments are written as `[i]` without a dot. Examples: `["user", "name"]` → `user.name`, `["tags", 2, "name"]` → `tags[2].name`, `[0]` → `[0]`, `[0, "id"]` → `[0].id`.

**Received type names** used in messages below (`<type>`): `null` → `null`, arrays → `array`, `NaN` → `nan`, otherwise the `typeof` result (`string`, `number`, `boolean`, `object`, `function`, `bigint`, `symbol`).

**Missing values**: every base schema (`string`, `number`, `boolean`, `literal`, `enum`, `object`, `array`) given `undefined` reports a single issue with message `Required` (it never says "received undefined").

## Schemas

**`s.string()`** — input must be a string, else `Expected string, received <type>`. Checks (each optionally takes a custom message as the last argument, replacing the default one):

| method | fails when | default message |
|---|---|---|
| `.min(n)` | length < n | `String must contain at least <n> character(s)` |
| `.max(n)` | length > n | `String must contain at most <n> character(s)` |
| `.length(n)` | length ≠ n | `String must contain exactly <n> character(s)` |
| `.email()` | does not match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` | `Invalid email` |
| `.regex(re)` | `re.test(value)` is false | `Invalid string` |

`.trim()`: the string is trimmed (`String.prototype.trim`) before any checks run (wherever `.trim()` appears in the chain) and the output is the trimmed string.
If the type is wrong, only the type issue is reported. Otherwise every failing check is reported, in chaining order, all with the same path.

**`s.number()`** — input must be a number and not `NaN`, else `Expected number, received <type>` (so `NaN` gives `Expected number, received nan`). Checks (custom message optional, same rules as strings):

| method | fails when | default message |
|---|---|---|
| `.int()` | not `Number.isInteger(value)` | `Expected integer, received float` |
| `.min(n)` | value < n | `Number must be greater than or equal to <n>` |
| `.max(n)` | value > n | `Number must be less than or equal to <n>` |
| `.positive()` | value <= 0 | `Number must be greater than 0` |

`<n>` is `String(n)`.

**`s.boolean()`** — `true` or `false`, else `Expected boolean, received <type>`.

**`s.literal(value)`** — `value` is a string, number, boolean or `null`; accepts only inputs `=== value`, else `Invalid literal value, expected <JSON.stringify(value)>` (e.g. `Invalid literal value, expected "admin"`, `Invalid literal value, expected 42`). Output type is the literal type (`s.literal("admin")` → `"admin"`).

**`s.enum(values)`** — `values` is a non-empty array of strings; accepts any of them. Otherwise `Invalid enum value. Expected 'a' | 'b', received 'x'`: the options each in single quotes joined by ` | `, and the received part is the input in single quotes when it is a string, otherwise its `<type>` (e.g. `received number`). Output type is the union of the values (`s.enum(["a", "b"])` → `"a" | "b"`, without needing `as const`).

**`s.object(shape)`** — `shape` maps keys to schemas. Input must be a non-null, non-array object, else `Expected object, received <type>`. Each shape key is validated with its schema (issue paths extended by the key); a key missing from the input is validated as `undefined`. The output is a new object containing only shape keys: a key is included when it was present in the input or when its parsed value is not `undefined` (so an absent `.optional()` key stays absent, an absent `.default(...)` key gets its default). Unknown input keys are **dropped** silently.
`.strict()` returns an object schema that additionally reports unknown keys as **one** issue at the object's own path, after all property issues: `Unrecognized key(s) in object: 'x', 'y'` (keys in input order, each in single quotes, joined by `, `).
Output type: keys whose schema's output type includes `undefined` (e.g. `.optional()`) are optional properties (`key?: T | undefined`); all other keys are required.

**`s.array(element)`** — input must be an array, else `Expected array, received <type>`. Every element is validated (issue paths extended by the index). Then length checks, in chaining order: `.min(n)` → `Array must contain at least <n> element(s)`, `.max(n)` → `Array must contain at most <n> element(s)` (custom message optional), with the array's own path. Element issues come before length issues. Output type `T[]`.

**`s.union([a, b, ...])`** — at least one option. Tries the options in order and returns the output of the first one that succeeds. If none succeeds, reports a single issue `Invalid input` at the union's path (the options' own issues are not reported). Output type is the union of the options' output types.

## Modifiers (available on every schema)

Type-specific checks (`.min()`, `.int()`, `.strict()`, ...) only need to be available on the schemas returned by `s.*` and by other type-specific checks; the modifiers below must work on every schema, including on the result of another modifier.

- `.optional()` — `undefined` → success with `undefined`; any other input goes to the wrapped schema. Output type `T | undefined`.
- `.nullable()` — `null` → success with `null`; otherwise the wrapped schema. Output type `T | null`.
- `.default(value)` — `undefined` → success with `value` (returned as is, not validated); otherwise the wrapped schema. Output type `T` without `undefined`; an object key with a default is a **required** property of the output type.
- `.refine(check, message?)` — runs the wrapped schema first; if it fails, its issues are reported and `check` is not called. Otherwise `check(output)` is called with the parsed value (typed as `T`); if it returns `false`, one issue with `message` (default `Invalid input`) at the value's path. Output type unchanged.

## Types

`Infer<typeof schema>` and the return types of `parse`/`safeParse` must be precise, for example:

```ts
const User = s.object({
  id: s.number().int(),
  name: s.string().min(1),
  email: s.string().email().optional(),
  role: s.enum(["admin", "member"]).default("member"),
  tags: s.array(s.string()),
  manager: s.object({ id: s.number() }).nullable(),
});
type User = Infer<typeof User>;
// { id: number; name: string; email?: string | undefined; role: "admin" | "member";
//   tags: string[]; manager: { id: number } | null }

const r = User.safeParse(input);
if (r.success) r.data.name;          // string
else r.error.issues;                 // Issue[]

function check(schema: Schema<string>) {}
check(s.string());                   // ok
check(s.number());                   // type error
```

A `Schema<T>` must not be assignable to `Schema<U>` when `T` is not assignable to `U`, and a missing required property or a wrong property type in an object literal annotated with an `Infer<...>` type must be a compile error.

Before finishing, run `tsc --noEmit -p .` and `node --test` and make sure both pass.
