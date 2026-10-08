import type { Account } from "../packages/accounts/src/types.ts";
import type { User } from "../packages/auth/src/types.ts";
import { parseAmount } from "../packages/shared/src/money.ts";
import type { AppDeps } from "../server/deps.ts";
import type { SeedData } from "./seed-data.ts";

/** Load seed data into empty repositories. Ledger entries go through the ledger so balances are consistent. */
export function applySeed(deps: AppDeps, seed: SeedData): void {
  const { repos, ids, ledger } = deps;
  const userIds = new Map<string, string>();
  const accounts = new Map<string, Account>();

  for (const u of seed.users) {
    const user: User = {
      id: ids.next("usr"),
      username: u.username,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      passwordHash: u.passwordHash,
      timezone: u.timezone,
      dailyTransferLimits: u.dailyTransferLimits ?? {},
      emailNotifications: u.emailNotifications,
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: u.createdAt,
    };
    repos.users.insert(user);
    userIds.set(u.username, user.id);
  }

  for (const a of seed.accounts) {
    const ownerId = userIds.get(a.owner);
    if (!ownerId) throw new Error(`seed: unknown account owner ${a.owner}`);
    const account = repos.accounts.insert({
      id: ids.next("acc"),
      ownerId,
      number: a.number,
      name: a.name,
      type: a.type,
      currency: a.currency,
      balanceMinor: 0,
      status: "active",
      openedAt: a.openedAt,
    });
    accounts.set(a.number, account);
  }

  const entries = [...seed.entries].sort((x, y) => x[1].localeCompare(y[1]));
  for (const [number, postedAt, type, amount, description, counterparty, category, reference] of entries) {
    const account = accounts.get(number);
    if (!account) throw new Error(`seed: unknown account ${number}`);
    const amountMinor = parseAmount(amount, account.currency);
    if (amountMinor === null) throw new Error(`seed: bad amount ${amount} for ${number}`);
    ledger.post(account.id, {
      type,
      amountMinor,
      description,
      counterparty,
      reference,
      category,
      transferId: null,
      postedAt: new Date(postedAt),
    });
  }

  // Freeze after posting so seed history can be written to every account.
  for (const a of seed.accounts) {
    if (a.status === "frozen") {
      const account = repos.accounts.findById(accounts.get(a.number)?.id ?? "");
      if (account) repos.accounts.update({ ...account, status: "frozen" });
    }
  }

  for (const c of seed.cards) {
    const account = accounts.get(c.account);
    if (!account) throw new Error(`seed: unknown card account ${c.account}`);
    repos.cards.insert({
      id: ids.next("crd"),
      accountId: account.id,
      ownerId: account.ownerId,
      last4: c.last4,
      network: "QuillPay",
      status: c.status,
      expiresMonth: c.expiresMonth,
      expiresYear: c.expiresYear,
      monthlySpendLimitMinor: 2_000_00,
      replacedById: null,
      createdAt: account.openedAt,
    });
  }

  for (const t of seed.tickets) {
    const userId = userIds.get(t.owner);
    if (!userId) throw new Error(`seed: unknown ticket owner ${t.owner}`);
    repos.tickets.insert({
      id: ids.next("tkt"),
      userId,
      subject: t.subject,
      category: t.category,
      status: "open",
      messages: [{ id: ids.next("msg"), authorId: userId, fromStaff: false, body: t.body, createdAt: t.createdAt }],
      createdAt: t.createdAt,
      updatedAt: t.createdAt,
    });
  }
}
