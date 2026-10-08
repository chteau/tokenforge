import type { Clock } from "../../shared/src/clock.ts";
import { MINUTE_MS } from "../../shared/src/clock.ts";
import { DomainError, notFound, validationError } from "../../shared/src/errors.ts";
import type { EventBus, DomainEvents } from "../../shared/src/events.ts";
import { isValidTimeZone } from "../../shared/src/dates.ts";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "./password.ts";
import type { SessionManager } from "./sessions.ts";
import { type Actor, type PublicUser, type User, type UserRepository, toActor, toPublicUser } from "./types.ts";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * MINUTE_MS;

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: PublicUser;
}

export interface AuthService {
  login(username: string, password: string): Promise<LoginResult>;
  logout(token: string): void;
  /** Resolve a session token into an actor, or undefined when invalid/expired. */
  authenticate(token: string): Actor | undefined;
  me(actor: Actor): PublicUser;
  updateProfile(actor: Actor, changes: { displayName?: string; timezone?: string; emailNotifications?: boolean }): PublicUser;
  changePassword(actor: Actor, current: string, next: string): Promise<void>;
}

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionManager;
  clock: Clock;
  events: EventBus<DomainEvents>;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { users, sessions, clock, events } = deps;

  function requireUser(userId: string): User {
    const user = users.findById(userId);
    if (!user) throw notFound("User");
    return user;
  }

  return {
    async login(username, password) {
      const user = users.findByUsername(username.trim().toLowerCase());
      const now = clock.now();
      if (user?.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
        throw new DomainError("TOO_MANY_ATTEMPTS", "Too many failed attempts, try again later");
      }
      const valid = user ? await verifyPassword(password, user.passwordHash) : false;
      if (!user || !valid) {
        if (user) {
          const attempts = user.failedLoginAttempts + 1;
          users.update({
            ...user,
            failedLoginAttempts: attempts >= MAX_FAILED_ATTEMPTS ? 0 : attempts,
            lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MS).toISOString() : null,
          });
        }
        throw new DomainError("UNAUTHENTICATED", "Invalid username or password");
      }
      const fresh = users.update({ ...user, failedLoginAttempts: 0, lockedUntil: null });
      const session = sessions.create(fresh.id);
      events.emit("userLoggedIn", { userId: fresh.id, at: now.toISOString() });
      return { token: session.token, expiresAt: session.expiresAt, user: toPublicUser(fresh) };
    },

    logout(token) {
      sessions.revoke(token);
    },

    authenticate(token) {
      const session = sessions.resolve(token);
      if (!session) return undefined;
      const user = users.findById(session.userId);
      return user ? toActor(user) : undefined;
    },

    me(actor) {
      return toPublicUser(requireUser(actor.userId));
    },

    updateProfile(actor, changes) {
      const user = requireUser(actor.userId);
      if (changes.timezone !== undefined && !isValidTimeZone(changes.timezone)) {
        throw validationError([{ field: "timezone", message: "must be a valid IANA time zone" }]);
      }
      const updated = users.update({
        ...user,
        displayName: changes.displayName ?? user.displayName,
        timezone: changes.timezone ?? user.timezone,
        emailNotifications: changes.emailNotifications ?? user.emailNotifications,
      });
      return toPublicUser(updated);
    },

    async changePassword(actor, current, next) {
      const user = requireUser(actor.userId);
      if (!(await verifyPassword(current, user.passwordHash))) {
        throw validationError([{ field: "currentPassword", message: "is incorrect" }]);
      }
      const issues = checkPasswordPolicy(next);
      if (issues.length) throw validationError(issues);
      users.update({ ...user, passwordHash: await hashPassword(next) });
      sessions.revokeAll(user.id);
    },
  };
}
