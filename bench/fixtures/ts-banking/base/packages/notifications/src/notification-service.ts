import type { Actor, UserRepository } from "../../auth/src/types.ts";
import type { Clock } from "../../shared/src/clock.ts";
import { notFound } from "../../shared/src/errors.ts";
import type { IdGenerator } from "../../shared/src/ids.ts";
import type { Notification, NotificationKind, NotificationRepository, OutboxEmail, OutboxRepository } from "./types.ts";

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body: string;
}

export interface NotificationService {
  /** In-app notification, plus an outbox email when the user opted in. */
  notify(userId: string, input: NotifyInput): Notification;
  list(actor: Actor, options?: { unreadOnly?: boolean }): Notification[];
  unreadCount(userId: string): number;
  markRead(actor: Actor, notificationId: string): Notification;
  markAllRead(actor: Actor): number;
}

export interface NotificationDeps {
  notifications: NotificationRepository;
  outbox: OutboxRepository;
  users: UserRepository;
  clock: Clock;
  ids: IdGenerator;
}

export function createNotificationService(deps: NotificationDeps): NotificationService {
  const { notifications, outbox, users, clock, ids } = deps;

  function queueEmail(to: string, subject: string, body: string): OutboxEmail {
    return outbox.insert({
      id: ids.next("eml"),
      to,
      subject: `[Quillmoor] ${subject}`,
      body,
      createdAt: clock.now().toISOString(),
      sentAt: null,
    });
  }

  return {
    notify(userId, input) {
      const created = notifications.insert({
        id: ids.next("ntf"),
        userId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        createdAt: clock.now().toISOString(),
        readAt: null,
      });
      const user = users.findById(userId);
      if (user?.emailNotifications) queueEmail(user.email, input.title, input.body);
      return created;
    },

    list(actor, options = {}) {
      const all = notifications.listByUser(actor.userId);
      return options.unreadOnly ? all.filter((n) => n.readAt === null) : all;
    },

    unreadCount(userId) {
      return notifications.listByUser(userId).filter((n) => n.readAt === null).length;
    },

    markRead(actor, notificationId) {
      const n = notifications.findById(notificationId);
      if (!n || n.userId !== actor.userId) throw notFound("Notification");
      if (n.readAt) return n;
      return notifications.update({ ...n, readAt: clock.now().toISOString() });
    },

    markAllRead(actor) {
      const now = clock.now().toISOString();
      let count = 0;
      for (const n of notifications.listByUser(actor.userId)) {
        if (n.readAt === null) {
          notifications.update({ ...n, readAt: now });
          count += 1;
        }
      }
      return count;
    },
  };
}
