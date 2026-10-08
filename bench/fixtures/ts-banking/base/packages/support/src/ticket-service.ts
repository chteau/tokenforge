import { can } from "../../auth/src/roles.ts";
import type { Actor } from "../../auth/src/types.ts";
import type { NotificationService } from "../../notifications/src/notification-service.ts";
import type { Clock } from "../../shared/src/clock.ts";
import { DomainError, notFound, validationError } from "../../shared/src/errors.ts";
import type { IdGenerator } from "../../shared/src/ids.ts";
import type { Ticket, TicketCategory, TicketRepository, TicketStatus } from "./types.ts";

export const MAX_OPEN_TICKETS = 5;

export interface TicketService {
  open(actor: Actor, input: { subject: string; category: TicketCategory; body: string }): Ticket;
  list(actor: Actor, filter?: { status?: TicketStatus }): Ticket[];
  get(actor: Actor, ticketId: string): Ticket;
  reply(actor: Actor, ticketId: string, body: string): Ticket;
  close(actor: Actor, ticketId: string): Ticket;
}

export function createTicketService(deps: {
  tickets: TicketRepository;
  notifications: NotificationService;
  clock: Clock;
  ids: IdGenerator;
}): TicketService {
  const { tickets, notifications, clock, ids } = deps;

  function visible(actor: Actor, ticketId: string): Ticket {
    const ticket = tickets.findById(ticketId);
    if (!ticket || (ticket.userId !== actor.userId && !can(actor, "tickets:read:any"))) throw notFound("Ticket");
    return ticket;
  }

  function checkBody(body: string): string {
    const trimmed = body.trim();
    if (trimmed.length < 1 || trimmed.length > 4000) {
      throw validationError([{ field: "body", message: "must be between 1 and 4000 characters" }]);
    }
    return trimmed;
  }

  return {
    open(actor, input) {
      const openCount = tickets.listByUser(actor.userId).filter((t) => t.status !== "closed").length;
      if (openCount >= MAX_OPEN_TICKETS) throw new DomainError("CONFLICT", "Too many open tickets");
      const now = clock.now().toISOString();
      return tickets.insert({
        id: ids.next("tkt"),
        userId: actor.userId,
        subject: input.subject.trim(),
        category: input.category,
        status: "open",
        messages: [{ id: ids.next("msg"), authorId: actor.userId, fromStaff: false, body: checkBody(input.body), createdAt: now }],
        createdAt: now,
        updatedAt: now,
      });
    },

    list(actor, filter = {}) {
      const all = can(actor, "tickets:read:any") ? tickets.list() : tickets.listByUser(actor.userId);
      return all
        .filter((t) => !filter.status || t.status === filter.status)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    get: visible,

    reply(actor, ticketId, body) {
      const ticket = visible(actor, ticketId);
      if (ticket.status === "closed") throw new DomainError("CONFLICT", "Ticket is closed");
      const fromStaff = ticket.userId !== actor.userId && can(actor, "tickets:reply:any");
      const now = clock.now().toISOString();
      const updated = tickets.update({
        ...ticket,
        status: fromStaff ? "awaiting_customer" : "open",
        messages: [...ticket.messages, { id: ids.next("msg"), authorId: actor.userId, fromStaff, body: checkBody(body), createdAt: now }],
        updatedAt: now,
      });
      if (fromStaff) {
        notifications.notify(ticket.userId, {
          kind: "ticket_reply",
          title: "Support replied to your request",
          body: `New reply on "${ticket.subject}".`,
        });
      }
      return updated;
    },

    close(actor, ticketId) {
      const ticket = visible(actor, ticketId);
      if (ticket.status === "closed") return ticket;
      return tickets.update({ ...ticket, status: "closed", updatedAt: clock.now().toISOString() });
    },
  };
}
