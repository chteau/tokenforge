import type { Currency } from "../../shared/src/money.ts";

export type Role = "customer" | "support" | "admin";

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  /** IANA time zone used to display dates and to compute "today" for limits. */
  timezone: string;
  /** Per-currency override of the default daily outgoing transfer limit, in minor units. */
  dailyTransferLimits: Partial<Record<Currency, number>>;
  emailNotifications: boolean;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
}

/** The authenticated principal passed from routes into services. */
export interface Actor {
  userId: string;
  role: Role;
  timezone: string;
}

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface UserRepository {
  insert(user: User): User;
  update(user: User): User;
  findById(id: string): User | undefined;
  findByUsername(username: string): User | undefined;
  list(): User[];
}

export interface SessionRepository {
  insert(session: Session): Session;
  update(session: Session): Session;
  findByToken(token: string): Session | undefined;
  delete(token: string): void;
  deleteForUser(userId: string): number;
}

export function toActor(user: User): Actor {
  return { userId: user.id, role: user.role, timezone: user.timezone };
}

export type PublicUser = Omit<User, "passwordHash" | "failedLoginAttempts" | "lockedUntil">;

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _hash, failedLoginAttempts: _attempts, lockedUntil: _locked, ...rest } = user;
  return rest;
}
