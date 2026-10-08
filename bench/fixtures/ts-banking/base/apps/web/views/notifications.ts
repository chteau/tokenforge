import type { Notification } from "../../../packages/notifications/src/types.ts";
import { html } from "../html.ts";
import { dateTime } from "./format.ts";
import { layout } from "./layout.ts";

export function renderNotificationsPage(model: {
  user: { displayName: string; timezone: string; unreadNotifications: number };
  notifications: Notification[];
}): string {
  const { user } = model;
  return layout(
    { title: "Inbox", nav: "notifications", user },
    html`<h1>Inbox</h1>
    <section class="card">
      ${model.notifications.length === 0
        ? html`<p class="empty">Nothing here yet.</p>`
        : html`<ul class="notifications">
            ${model.notifications.map(
              (n) => html`<li class="${n.readAt ? "read" : "unread"}" data-kind="${n.kind}">
                <strong>${n.title}</strong>
                <p>${n.body}</p>
                <small>${dateTime(n.createdAt, user.timezone)}</small>
              </li>`,
            )}
          </ul>`}
    </section>`,
  );
}
