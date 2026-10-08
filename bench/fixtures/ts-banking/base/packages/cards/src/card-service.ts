import { randomInt } from "node:crypto";
import type { AccountService } from "../../accounts/src/account-service.ts";
import type { Actor } from "../../auth/src/types.ts";
import type { NotificationService } from "../../notifications/src/notification-service.ts";
import type { Clock } from "../../shared/src/clock.ts";
import { DomainError, invalidTransition, notFound, validationError } from "../../shared/src/errors.ts";
import type { IdGenerator } from "../../shared/src/ids.ts";
import { localParts } from "../../shared/src/dates.ts";
import type { Card, CardRepository, CardStatus } from "./types.ts";

export const MAX_MONTHLY_SPEND_MINOR = 25_000_00;
const CARD_VALIDITY_YEARS = 4;

const NEXT_STATUS: Record<CardStatus, readonly CardStatus[]> = {
  active: ["frozen", "lost", "expired"],
  frozen: ["active", "lost", "expired"],
  lost: ["replaced"],
  replaced: [],
  expired: [],
};

export interface CardService {
  listForUser(actor: Actor): Card[];
  issue(actor: Actor, accountId: string): Card;
  freeze(actor: Actor, cardId: string): Card;
  unfreeze(actor: Actor, cardId: string): Card;
  reportLost(actor: Actor, cardId: string): { lost: Card; replacement: Card };
  setMonthlyLimit(actor: Actor, cardId: string, limitMinor: number): Card;
}

export interface CardServiceDeps {
  cards: CardRepository;
  accounts: AccountService;
  notifications: NotificationService;
  clock: Clock;
  ids: IdGenerator;
}

export function createCardService(deps: CardServiceDeps): CardService {
  const { cards, accounts, notifications, clock, ids } = deps;

  function ownedCard(actor: Actor, cardId: string): Card {
    const card = cards.findById(cardId);
    if (!card || card.ownerId !== actor.userId) throw notFound("Card");
    return card;
  }

  function move(card: Card, to: CardStatus): Card {
    if (!NEXT_STATUS[card.status].includes(to)) throw invalidTransition("card", card.status, to);
    return cards.update({ ...card, status: to });
  }

  function newCard(accountId: string, ownerId: string): Card {
    const now = clock.now();
    const { year, month } = localParts(now, "UTC");
    return cards.insert({
      id: ids.next("crd"),
      accountId,
      ownerId,
      last4: String(randomInt(0, 10_000)).padStart(4, "0"),
      network: "QuillPay",
      status: "active",
      expiresMonth: month,
      expiresYear: year + CARD_VALIDITY_YEARS,
      monthlySpendLimitMinor: 2_000_00,
      replacedById: null,
      createdAt: now.toISOString(),
    });
  }

  return {
    listForUser(actor) {
      return cards.listByOwner(actor.userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    issue(actor, accountId) {
      const account = accounts.requireOwned(actor, accountId);
      if (account.type === "savings") throw new DomainError("CONFLICT", "Cards cannot be issued on savings accounts");
      const live = cards.listByAccount(account.id).filter((c) => c.status === "active" || c.status === "frozen");
      if (live.length >= 2) throw new DomainError("CONFLICT", "An account can have at most two cards");
      return newCard(account.id, actor.userId);
    },

    freeze(actor, cardId) {
      const card = move(ownedCard(actor, cardId), "frozen");
      notifications.notify(actor.userId, {
        kind: "card_frozen",
        title: "Card frozen",
        body: `Your card ending in ${card.last4} is frozen. Unfreeze it any time from the Cards page.`,
      });
      return card;
    },

    unfreeze(actor, cardId) {
      return move(ownedCard(actor, cardId), "active");
    },

    reportLost(actor, cardId) {
      const card = ownedCard(actor, cardId);
      const lost = move(card, "lost");
      const replacement = newCard(card.accountId, card.ownerId);
      const replaced = cards.update({ ...move(lost, "replaced"), replacedById: replacement.id });
      notifications.notify(actor.userId, {
        kind: "card_replaced",
        title: "Replacement card on its way",
        body: `Card ending in ${card.last4} was cancelled. Your new card ends in ${replacement.last4}.`,
      });
      return { lost: replaced, replacement };
    },

    setMonthlyLimit(actor, cardId, limitMinor) {
      const card = ownedCard(actor, cardId);
      if (!Number.isSafeInteger(limitMinor) || limitMinor < 0 || limitMinor > MAX_MONTHLY_SPEND_MINOR) {
        throw validationError([{ field: "monthlySpendLimit", message: "is outside the allowed range" }]);
      }
      if (card.status !== "active" && card.status !== "frozen") {
        throw new DomainError("CARD_BLOCKED", "Card is no longer usable");
      }
      return cards.update({ ...card, monthlySpendLimitMinor: limitMinor });
    },
  };
}
