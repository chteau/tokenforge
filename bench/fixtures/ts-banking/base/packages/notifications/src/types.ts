export type NotificationKind =
  | "transfer_sent"
  | "transfer_received"
  | "transfer_reversed"
  | "deposit"
  | "card_frozen"
  | "card_replaced"
  | "ticket_reply"
  | "statement_ready"
  | "security";

export interface Notification {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface OutboxEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string;
  sentAt: string | null;
}

export interface NotificationRepository {
  insert(notification: Notification): Notification;
  update(notification: Notification): Notification;
  findById(id: string): Notification | undefined;
  /** Newest first. */
  listByUser(userId: string): Notification[];
}

export interface OutboxRepository {
  insert(email: OutboxEmail): OutboxEmail;
  update(email: OutboxEmail): OutboxEmail;
  listPending(): OutboxEmail[];
  list(): OutboxEmail[];
}
