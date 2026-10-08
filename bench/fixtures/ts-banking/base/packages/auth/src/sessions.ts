import { randomBytes } from "node:crypto";
import type { Clock } from "../../shared/src/clock.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/src/clock.ts";
import type { Session, SessionRepository } from "./types.ts";

export const SESSION_TTL_MS = 12 * HOUR_MS;
export const SESSION_IDLE_MS = 30 * MINUTE_MS;

export interface SessionManager {
  create(userId: string): Session;
  /** Returns the live session for `token` (refreshing lastSeenAt) or undefined. */
  resolve(token: string): Session | undefined;
  revoke(token: string): void;
  revokeAll(userId: string): number;
}

export function createSessionManager(deps: { sessions: SessionRepository; clock: Clock }): SessionManager {
  const { sessions, clock } = deps;
  return {
    create(userId) {
      const now = clock.now();
      const session: Session = {
        token: randomBytes(32).toString("base64url"),
        userId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        lastSeenAt: now.toISOString(),
      };
      return sessions.insert(session);
    },
    resolve(token) {
      const session = sessions.findByToken(token);
      if (!session) return undefined;
      const now = clock.now().getTime();
      const expired = now >= Date.parse(session.expiresAt);
      const idle = now - Date.parse(session.lastSeenAt) >= SESSION_IDLE_MS;
      if (expired || idle) {
        sessions.delete(token);
        return undefined;
      }
      return sessions.update({ ...session, lastSeenAt: new Date(now).toISOString() });
    },
    revoke(token) {
      sessions.delete(token);
    },
    revokeAll(userId) {
      return sessions.deleteForUser(userId);
    },
  };
}
