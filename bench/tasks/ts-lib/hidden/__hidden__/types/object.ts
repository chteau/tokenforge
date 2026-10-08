import { s, type Infer } from "../../src/index.ts";

const User = s.object({
  id: s.number().int(),
  name: s.string().min(1),
  email: s.string().email().optional(),
  role: s.enum(["admin", "member"]).default("member"),
  manager: s.object({ id: s.number() }).nullable(),
});
type User = Infer<typeof User>;

const minimal: User = { id: 1, name: "Ada", role: "member", manager: null };
const full: User = { id: 1, name: "Ada", email: "a@b.co", role: "admin", manager: { id: 2 } };
const parsed: User = User.parse({});
const id: number = parsed.id;
const email: string | undefined = parsed.email;
const role: "admin" | "member" = parsed.role;

// @ts-expect-error id is required
const missingId: User = { name: "Ada", role: "member", manager: null };
// @ts-expect-error role has a default, so it is required in the output type
const missingRole: User = { id: 1, name: "Ada", manager: null };
// @ts-expect-error wrong property type
const wrongType: User = { id: "1", name: "Ada", role: "member", manager: null };
// @ts-expect-error role is limited to the enum values
const wrongRole: User = { id: 1, name: "Ada", role: "owner", manager: null };
// @ts-expect-error optional property may be undefined
const emailStr: string = parsed.email;
// @ts-expect-error nullable property may be null
const managerId: number = parsed.manager.id;

export { minimal, full, id, email, role, missingId, missingRole, wrongType, wrongRole, emailStr, managerId };
