// Composition root: builds repositories, caches and services and wires them
// together. Services only receive what they need through their deps object;
// nothing reaches for module-level singletons. Tests build their own deps with
// a manual clock and deterministic ids:
//
//   const deps = createDeps({ clock: createManualClock("2026-10-07T12:00:00Z") });
//   const app = createApp(deps);

import { createAccountService, type AccountService } from "../packages/accounts/src/account-service.ts";
import type { AccountRepository } from "../packages/accounts/src/types.ts";
import { createAuthService, type AuthService } from "../packages/auth/src/auth-service.ts";
import { createSessionManager, type SessionManager } from "../packages/auth/src/sessions.ts";
import type { SessionRepository, UserRepository } from "../packages/auth/src/types.ts";
import { createCardService, type CardService } from "../packages/cards/src/card-service.ts";
import type { CardRepository } from "../packages/cards/src/types.ts";
import { createNotificationService, type NotificationService } from "../packages/notifications/src/notification-service.ts";
import { createMemoryTransport, type MailTransport } from "../packages/notifications/src/outbox.ts";
import type { NotificationRepository, OutboxRepository } from "../packages/notifications/src/types.ts";
import { type Clock, systemClock } from "../packages/shared/src/clock.ts";
import { createEventBus, type DomainEvents, type EventBus } from "../packages/shared/src/events.ts";
import { type IdGenerator, randomIds, sequentialIds } from "../packages/shared/src/ids.ts";
import { createStatementService, type StatementService } from "../packages/statements/src/statement-service.ts";
import { createTicketService, type TicketService } from "../packages/support/src/ticket-service.ts";
import type { TicketRepository } from "../packages/support/src/types.ts";
import { createLedger, type Ledger } from "../packages/transactions/src/ledger.ts";
import { createTransactionService, type TransactionService } from "../packages/transactions/src/transaction-service.ts";
import type { LedgerRepository } from "../packages/transactions/src/types.ts";
import { createTransferService, type TransferService } from "../packages/transfers/src/transfer-service.ts";
import type { TransferRepository } from "../packages/transfers/src/types.ts";
import { applySeed } from "../seed/apply-seed.ts";
import { defaultSeed, type SeedData } from "../seed/seed-data.ts";
import { createSummaryCache, type SummaryCache } from "./cache/summary-cache.ts";
import { type AppConfig, resolveConfig } from "./config.ts";
import { type Logger, silentLogger } from "./logger.ts";
import { createJsonFileStore, createNullStore, type DataStore } from "./repositories/json-file-store.ts";
import { createMemoryAccountRepository } from "./repositories/memory/accounts.ts";
import { createMemoryCardRepository } from "./repositories/memory/cards.ts";
import { createMemoryLedgerRepository } from "./repositories/memory/ledger.ts";
import { createMemoryNotificationRepository, createMemoryOutboxRepository } from "./repositories/memory/notifications.ts";
import { createMemorySessionRepository } from "./repositories/memory/sessions.ts";
import { createMemoryTicketRepository } from "./repositories/memory/tickets.ts";
import { createMemoryTransferRepository } from "./repositories/memory/transfers.ts";
import { createMemoryUserRepository } from "./repositories/memory/users.ts";
import { createDashboardService, type DashboardService } from "./services/dashboard-service.ts";

export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  accounts: AccountRepository;
  ledger: LedgerRepository;
  transfers: TransferRepository;
  notifications: NotificationRepository;
  outbox: OutboxRepository;
  cards: CardRepository;
  tickets: TicketRepository;
}

export interface Services {
  auth: AuthService;
  sessions: SessionManager;
  accounts: AccountService;
  transactions: TransactionService;
  transfers: TransferService;
  notifications: NotificationService;
  cards: CardService;
  statements: StatementService;
  tickets: TicketService;
  dashboard: DashboardService;
}

export interface AppDeps {
  config: AppConfig;
  clock: Clock;
  ids: IdGenerator;
  events: EventBus<DomainEvents>;
  logger: Logger;
  store: DataStore;
  repos: Repositories;
  ledger: Ledger;
  caches: { summary: SummaryCache };
  mail: MailTransport;
  services: Services;
}

export interface CreateDepsOptions {
  clock?: Clock;
  ids?: IdGenerator;
  /** Seed data for an empty store; `false` starts with no data. Defaults to the demo seed. */
  seed?: SeedData | false;
  /** Persist to (and load from) this JSON file. */
  dataFile?: string;
  config?: Partial<AppConfig>;
  logger?: Logger;
}

export function createDeps(options: CreateDepsOptions = {}): AppDeps {
  const config = resolveConfig(options.config);
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? (options.dataFile ? randomIds : sequentialIds());
  const logger = options.logger ?? silentLogger;
  const events = createEventBus<DomainEvents>();

  const users = createMemoryUserRepository();
  const sessionsRepo = createMemorySessionRepository();
  const accountsRepo = createMemoryAccountRepository();
  const ledgerRepo = createMemoryLedgerRepository();
  const transfersRepo = createMemoryTransferRepository();
  const notificationsRepo = createMemoryNotificationRepository();
  const outbox = createMemoryOutboxRepository();
  const cardsRepo = createMemoryCardRepository();
  const ticketsRepo = createMemoryTicketRepository();

  const store = options.dataFile ? createJsonFileStore(options.dataFile, () => clock.now()) : createNullStore();
  store.register("users", users);
  store.register("sessions", sessionsRepo);
  store.register("accounts", accountsRepo);
  store.register("ledger", ledgerRepo);
  store.register("transfers", transfersRepo);
  store.register("notifications", notificationsRepo);
  store.register("outbox", outbox);
  store.register("cards", cardsRepo);
  store.register("tickets", ticketsRepo);

  const summaryCache = createSummaryCache({ clock, ttlMs: config.cache.summaryTtlMs });
  events.on("accountsChanged", ({ changes }) => {
    for (const change of changes) summaryCache.invalidate(change);
  });

  const ledger = createLedger({ entries: ledgerRepo, accounts: accountsRepo, clock, ids });
  const sessions = createSessionManager({ sessions: sessionsRepo, clock });
  const auth = createAuthService({ users, sessions, clock, events });
  const notifications = createNotificationService({ notifications: notificationsRepo, outbox, users, clock, ids });
  const accounts = createAccountService({ accounts: accountsRepo, ledger, clock, ids, events });
  const transactions = createTransactionService({ entries: ledgerRepo, accounts });
  const transfers = createTransferService({
    transfers: transfersRepo,
    accounts,
    users,
    ledger,
    notifications,
    clock,
    ids,
    events,
  });
  const cards = createCardService({ cards: cardsRepo, accounts, notifications, clock, ids });
  const statements = createStatementService({ accounts, entries: ledgerRepo, users, clock });
  const tickets = createTicketService({ tickets: ticketsRepo, notifications, clock, ids });
  const dashboard = createDashboardService({
    users,
    accounts,
    entries: ledgerRepo,
    transactions,
    notifications,
    summaryCache,
    clock,
  });

  const deps: AppDeps = {
    config,
    clock,
    ids,
    events,
    logger,
    store,
    repos: {
      users,
      sessions: sessionsRepo,
      accounts: accountsRepo,
      ledger: ledgerRepo,
      transfers: transfersRepo,
      notifications: notificationsRepo,
      outbox,
      cards: cardsRepo,
      tickets: ticketsRepo,
    },
    ledger,
    caches: { summary: summaryCache },
    mail: createMemoryTransport(),
    services: { auth, sessions, accounts, transactions, transfers, notifications, cards, statements, tickets, dashboard },
  };

  const loaded = store.load();
  if (!loaded && options.seed !== false) {
    applySeed(deps, options.seed ?? defaultSeed);
    store.save();
  }
  return deps;
}
