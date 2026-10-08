export type TicketStatus = "open" | "awaiting_customer" | "closed";
export type TicketCategory = "cards" | "transfers" | "account" | "technical" | "other";

export interface TicketMessage {
  id: string;
  authorId: string;
  fromStaff: boolean;
  body: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  userId: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  messages: TicketMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface TicketRepository {
  insert(ticket: Ticket): Ticket;
  update(ticket: Ticket): Ticket;
  findById(id: string): Ticket | undefined;
  listByUser(userId: string): Ticket[];
  list(): Ticket[];
}
