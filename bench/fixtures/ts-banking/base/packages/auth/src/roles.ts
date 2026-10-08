import { forbidden } from "../../shared/src/errors.ts";
import type { Actor, Role } from "./types.ts";

export type Permission =
  | "accounts:read:any"
  | "accounts:deposit"
  | "accounts:freeze"
  | "transfers:reverse"
  | "tickets:read:any"
  | "tickets:reply:any"
  | "users:read:any"
  | "ops:cache"
  | "ops:jobs";

const GRANTS: Record<Role, readonly Permission[]> = {
  customer: [],
  support: ["accounts:read:any", "tickets:read:any", "tickets:reply:any", "users:read:any"],
  admin: [
    "accounts:read:any",
    "accounts:deposit",
    "accounts:freeze",
    "transfers:reverse",
    "tickets:read:any",
    "tickets:reply:any",
    "users:read:any",
    "ops:cache",
    "ops:jobs",
  ],
};

export function can(actor: Pick<Actor, "role">, permission: Permission): boolean {
  return GRANTS[actor.role].includes(permission);
}

export function requirePermission(actor: Pick<Actor, "role">, permission: Permission): void {
  if (!can(actor, permission)) throw forbidden();
}

export function isStaff(actor: Pick<Actor, "role">): boolean {
  return actor.role === "admin" || actor.role === "support";
}
