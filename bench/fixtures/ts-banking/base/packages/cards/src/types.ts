export type CardStatus = "active" | "frozen" | "lost" | "replaced" | "expired";

export interface Card {
  id: string;
  accountId: string;
  ownerId: string;
  last4: string;
  network: "QuillPay";
  status: CardStatus;
  expiresMonth: number;
  expiresYear: number;
  monthlySpendLimitMinor: number;
  replacedById: string | null;
  createdAt: string;
}

export interface CardRepository {
  insert(card: Card): Card;
  update(card: Card): Card;
  findById(id: string): Card | undefined;
  listByOwner(ownerId: string): Card[];
  listByAccount(accountId: string): Card[];
}
