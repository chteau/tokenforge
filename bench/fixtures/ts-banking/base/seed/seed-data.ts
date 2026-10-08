// Demo data for local development and tests. Everyone and everything here is
// fictional. Seed passwords use a reduced scrypt cost so test suites stay fast;
// real sign-ups use DEFAULT_SCRYPT.
//
//   alice / alice-harbor-2026   (America/New_York)
//   bob   / bob-harbor-2026     (Europe/London)
//   carol / carol-harbor-2026   (Asia/Tokyo)
//   dana  / dana-harbor-2026    (Europe/Berlin)
//   olive / olive-admin-2026    (admin)
//   sam   / sam-support-2026    (support)

import type { AccountType } from "../packages/accounts/src/types.ts";
import type { Role } from "../packages/auth/src/types.ts";
import type { Currency } from "../packages/shared/src/money.ts";
import type { EntryCategory, EntryType } from "../packages/transactions/src/types.ts";

export interface SeedUser {
  username: string;
  displayName: string;
  email: string;
  role: Role;
  passwordHash: string;
  timezone: string;
  emailNotifications: boolean;
  dailyTransferLimits?: Partial<Record<Currency, number>>;
  createdAt: string;
}

export interface SeedAccount {
  number: string;
  owner: string;
  name: string;
  type: AccountType;
  currency: Currency;
  openedAt: string;
  status?: "active" | "frozen";
}

/** [account number, postedAt (UTC), type, amount, description, counterparty, category, reference] */
export type SeedEntry = [string, string, EntryType, string, string, string | null, EntryCategory, string | null];

export interface SeedCard {
  account: string;
  last4: string;
  status: "active" | "frozen";
  expiresMonth: number;
  expiresYear: number;
}

export interface SeedTicket {
  owner: string;
  subject: string;
  category: "cards" | "transfers" | "account" | "technical" | "other";
  body: string;
  createdAt: string;
}

export interface SeedData {
  users: SeedUser[];
  accounts: SeedAccount[];
  entries: SeedEntry[];
  cards: SeedCard[];
  tickets: SeedTicket[];
}

export const SEED_PASSWORDS = {
  alice: "alice-harbor-2026",
  bob: "bob-harbor-2026",
  carol: "carol-harbor-2026",
  dana: "dana-harbor-2026",
  olive: "olive-admin-2026",
  sam: "sam-support-2026",
} as const;

export const defaultSeed: SeedData = {
  users: [
    {
      username: "alice",
      displayName: "Alice Marlow",
      email: "alice.marlow@example.test",
      role: "customer",
      passwordHash: "scrypt$4096$8$1$d6mfBQVT92YSN4qZDjHpcg$8JVDGh72EQ0fCd0230gmMtnjIaRooMOS982zp4xsU_E",
      timezone: "America/New_York",
      emailNotifications: true,
      createdAt: "2026-06-28T14:00:00.000Z",
    },
    {
      username: "bob",
      displayName: "Bob Okafor",
      email: "bob.okafor@example.test",
      role: "customer",
      passwordHash: "scrypt$4096$8$1$qDZc-qZiWJp_qrQs40EP9w$d768Ef3Rp13nMtGT1PCGdmJLoIINmLaXhgWGwbUyWDM",
      timezone: "Europe/London",
      emailNotifications: false,
      dailyTransferLimits: { GBP: 2_500_00 },
      createdAt: "2026-06-30T09:30:00.000Z",
    },
    {
      username: "carol",
      displayName: "Carol Nakamura",
      email: "carol.nakamura@example.test",
      role: "customer",
      passwordHash: "scrypt$4096$8$1$jGpozW9xzgc3aEfGHTfH9Q$bNdpR-pb5s92kJfippj8cOCqSFuluFbXMMxPaHlgkSE",
      timezone: "Asia/Tokyo",
      emailNotifications: true,
      createdAt: "2026-07-02T01:15:00.000Z",
    },
    {
      username: "dana",
      displayName: "Dana Weiss",
      email: "dana.weiss@example.test",
      role: "customer",
      passwordHash: "scrypt$4096$8$1$VTGtBKkdUIDgDz6XMqjHQg$vigVrT1jA9Yh_ccGRWk72bsgDaR9QTT1vXMr4ANRlLQ",
      timezone: "Europe/Berlin",
      emailNotifications: false,
      createdAt: "2026-07-05T08:00:00.000Z",
    },
    {
      username: "olive",
      displayName: "Olive Brandt",
      email: "olive.brandt@quillmoor.example.test",
      role: "admin",
      passwordHash: "scrypt$4096$8$1$XiD6lfWfdbenBnNUJh5zig$Gid6XURy_y_Vp-UUVGDzLjwoMC6N-ZynbAR1txtSPRs",
      timezone: "America/Chicago",
      emailNotifications: false,
      createdAt: "2026-06-01T12:00:00.000Z",
    },
    {
      username: "sam",
      displayName: "Sam Ortiz",
      email: "sam.ortiz@quillmoor.example.test",
      role: "support",
      passwordHash: "scrypt$4096$8$1$ktXaK2P3ZiC6dVXJqtBglA$VwbdtmpF0RzC4kw9shK62e1sM7oaluI6TsZgM8c7pbU",
      timezone: "America/Chicago",
      emailNotifications: false,
      createdAt: "2026-06-01T12:05:00.000Z",
    },
  ],

  accounts: [
    { number: "QM-1000-0001", owner: "alice", name: "Everyday", type: "checking", currency: "USD", openedAt: "2026-07-01T13:00:00.000Z" },
    { number: "QM-1000-0002", owner: "alice", name: "Rainy Day", type: "savings", currency: "USD", openedAt: "2026-07-01T13:05:00.000Z" },
    { number: "QM-1000-0003", owner: "alice", name: "Lisbon Trip", type: "travel", currency: "EUR", openedAt: "2026-08-10T15:00:00.000Z" },
    { number: "QM-1000-0004", owner: "bob", name: "Current", type: "checking", currency: "GBP", openedAt: "2026-07-01T08:00:00.000Z" },
    { number: "QM-1000-0005", owner: "bob", name: "Dollar Account", type: "checking", currency: "USD", openedAt: "2026-07-03T10:00:00.000Z" },
    { number: "QM-1000-0006", owner: "carol", name: "Main", type: "checking", currency: "JPY", openedAt: "2026-07-02T02:00:00.000Z" },
    { number: "QM-1000-0007", owner: "carol", name: "USD Savings", type: "savings", currency: "USD", openedAt: "2026-07-02T02:10:00.000Z" },
    { number: "QM-1000-0008", owner: "dana", name: "Girokonto", type: "checking", currency: "EUR", openedAt: "2026-07-05T08:30:00.000Z" },
    { number: "QM-1000-0009", owner: "dana", name: "Notgroschen", type: "savings", currency: "EUR", openedAt: "2026-07-05T08:35:00.000Z", status: "frozen" },
  ],

  entries: [
    // Alice - Everyday (USD, America/New_York)
    ["QM-1000-0001", "2026-07-01T13:30:00.000Z", "credit", "2500.00", "Opening deposit", "Quillmoor Bank", "deposit", null],
    ["QM-1000-0001", "2026-07-03T16:12:00.000Z", "debit", "4.75", "Blue Kettle Coffee", "Blue Kettle Coffee", "card", null],
    ["QM-1000-0001", "2026-07-10T21:40:00.000Z", "debit", "86.20", "Greenleaf Market", "Greenleaf Market", "card", null],
    ["QM-1000-0001", "2026-07-15T12:00:00.000Z", "credit", "3150.00", "Salary July", "Northwind Fabrication LLC", "salary", "PAY-2026-07"],
    ["QM-1000-0001", "2026-07-18T23:05:00.000Z", "debit", "1450.00", "Rent July", "Harborview Apartments", "card", "UNIT 4B"],
    ["QM-1000-0001", "2026-07-22T17:45:00.000Z", "debit", "12.99", "Streamly subscription", "Streamly", "card", null],
    ["QM-1000-0001", "2026-08-02T14:20:00.000Z", "debit", "5.25", "Blue Kettle Coffee", "Blue Kettle Coffee", "card", null],
    ["QM-1000-0001", "2026-08-09T19:00:00.000Z", "debit", "64.10", "Greenleaf Market", "Greenleaf Market", "card", null],
    ["QM-1000-0001", "2026-08-14T12:00:00.000Z", "credit", "3150.00", "Salary August", "Northwind Fabrication LLC", "salary", "PAY-2026-08"],
    ["QM-1000-0001", "2026-08-18T23:10:00.000Z", "debit", "1450.00", "Rent August", "Harborview Apartments", "card", "UNIT 4B"],
    ["QM-1000-0001", "2026-08-22T17:45:00.000Z", "debit", "12.99", "Streamly subscription", "Streamly", "card", null],
    ["QM-1000-0001", "2026-08-27T20:30:00.000Z", "debit", "38.40", "Dinner at \"The Anchor\", Pier 9", "The Anchor", "card", null],
    ["QM-1000-0001", "2026-09-01T02:30:00.000Z", "debit", "23.80", "Late-night pharmacy", "Lindqvist Pharmacy", "card", null],
    ["QM-1000-0001", "2026-09-01T14:00:00.000Z", "debit", "120.00", "Gym membership", "Ironworks Gym", "card", null],
    ["QM-1000-0001", "2026-09-05T15:35:00.000Z", "debit", "4.75", "Blue Kettle Coffee", "Blue Kettle Coffee", "card", null],
    ["QM-1000-0001", "2026-09-12T18:15:00.000Z", "debit", "212.35", "Hardware & garden, Elm St", "Pemberton Hardware", "card", null],
    ["QM-1000-0001", "2026-09-15T12:00:00.000Z", "credit", "3150.00", "Salary September", "Northwind Fabrication LLC", "salary", "PAY-2026-09"],
    ["QM-1000-0001", "2026-09-18T23:00:00.000Z", "debit", "1450.00", "Rent September", "Harborview Apartments", "card", "UNIT 4B"],
    ["QM-1000-0001", "2026-09-22T17:45:00.000Z", "debit", "12.99", "Streamly subscription", "Streamly", "card", null],
    ["QM-1000-0001", "2026-09-28T13:00:00.000Z", "credit", "45.00", "Refund: returned boots", "Trailhead Outfitters", "card", "RMA-88213"],
    ["QM-1000-0001", "2026-10-01T03:45:00.000Z", "debit", "9.60", "Night bus pass", "Metro Transit", "card", null],
    ["QM-1000-0001", "2026-10-02T16:10:00.000Z", "debit", "5.25", "Blue Kettle Coffee", "Blue Kettle Coffee", "card", null],
    ["QM-1000-0001", "2026-10-03T19:30:00.000Z", "debit", "71.45", "Greenleaf Market", "Greenleaf Market", "card", null],
    ["QM-1000-0001", "2026-10-05T22:00:00.000Z", "debit", "300.00", "=Concert tickets", "Lyric Hall Box Office", "card", null],
    ["QM-1000-0001", "2026-10-06T12:30:00.000Z", "credit", "0.42", "Interest", "Quillmoor Bank", "interest", null],

    // Alice - Rainy Day (USD)
    ["QM-1000-0002", "2026-07-01T13:35:00.000Z", "credit", "5000.00", "Opening deposit", "Quillmoor Bank", "deposit", null],
    ["QM-1000-0002", "2026-07-31T12:00:00.000Z", "credit", "6.25", "Interest", "Quillmoor Bank", "interest", null],
    ["QM-1000-0002", "2026-08-31T12:00:00.000Z", "credit", "6.31", "Interest", "Quillmoor Bank", "interest", null],
    ["QM-1000-0002", "2026-09-30T12:00:00.000Z", "credit", "6.18", "Interest", "Quillmoor Bank", "interest", null],

    // Alice - Lisbon Trip (EUR)
    ["QM-1000-0003", "2026-08-10T15:10:00.000Z", "credit", "800.00", "Opening deposit", "Quillmoor Bank", "deposit", null],
    ["QM-1000-0003", "2026-09-20T10:15:00.000Z", "debit", "18.50", "Café \"Pastelaria Sol\", Lisboa", "Pastelaria Sol", "card", null],
    ["QM-1000-0003", "2026-09-21T19:40:00.000Z", "debit", "64.00", "Tram 28 & museum pass", "Lisboa Card", "card", null],

    // Bob - Current (GBP, Europe/London)
    ["QM-1000-0004", "2026-07-01T08:15:00.000Z", "credit", "1800.00", "Opening deposit", "Quillmoor Bank", "deposit", null],
    ["QM-1000-0004", "2026-07-25T09:00:00.000Z", "credit", "2650.00", "Salary July", "Fenmoor Logistics Ltd", "salary", null],
    ["QM-1000-0004", "2026-08-01T07:30:00.000Z", "debit", "1100.00", "Rent", "Canal Street Lettings", "card", null],
    ["QM-1000-0004", "2026-08-25T09:00:00.000Z", "credit", "2650.00", "Salary August", "Fenmoor Logistics Ltd", "salary", null],
    ["QM-1000-0004", "2026-09-01T07:30:00.000Z", "debit", "1100.00", "Rent", "Canal Street Lettings", "card", null],
    ["QM-1000-0004", "2026-09-25T09:00:00.000Z", "credit", "2650.00", "Salary September", "Fenmoor Logistics Ltd", "salary", null],
    ["QM-1000-0004", "2026-10-01T07:30:00.000Z", "debit", "1100.00", "Rent", "Canal Street Lettings", "card", null],

    // Bob - Dollar Account (USD)
    ["QM-1000-0005", "2026-07-03T10:05:00.000Z", "credit", "400.00", "Opening deposit", "Quillmoor Bank", "deposit", null],
    ["QM-1000-0005", "2026-09-09T15:00:00.000Z", "debit", "35.00", "Online course", "Learnwell Inc", "card", null],

    // Carol - Main (JPY, Asia/Tokyo)
    ["QM-1000-0006", "2026-07-02T02:05:00.000Z", "credit", "350000", "Opening deposit", "Quillmoor Bank", "deposit", null],
    ["QM-1000-0006", "2026-07-24T23:00:00.000Z", "credit", "410000", "Salary July", "Kisaragi Design KK", "salary", null],
    ["QM-1000-0006", "2026-08-03T03:00:00.000Z", "debit", "98000", "Rent", "Sakura Heights", "card", null],
    ["QM-1000-0006", "2026-08-24T23:00:00.000Z", "credit", "410000", "Salary August", "Kisaragi Design KK", "salary", null],
    ["QM-1000-0006", "2026-09-03T03:00:00.000Z", "debit", "98000", "Rent", "Sakura Heights", "card", null],
    ["QM-1000-0006", "2026-09-24T23:00:00.000Z", "credit", "410000", "Salary September", "Kisaragi Design KK", "salary", null],

    // Carol - USD Savings
    ["QM-1000-0007", "2026-07-02T02:15:00.000Z", "credit", "1200.00", "Opening deposit", "Quillmoor Bank", "deposit", null],

    // Dana - Girokonto (EUR, Europe/Berlin)
    ["QM-1000-0008", "2026-07-05T08:40:00.000Z", "credit", "2200.00", "Opening deposit", "Quillmoor Bank", "deposit", null],
    ["QM-1000-0008", "2026-07-30T07:00:00.000Z", "credit", "3400.00", "Gehalt Juli", "Elbwerk GmbH", "salary", null],
    ["QM-1000-0008", "2026-08-30T07:00:00.000Z", "credit", "3400.00", "Gehalt August", "Elbwerk GmbH", "salary", null],
    ["QM-1000-0008", "2026-09-02T10:00:00.000Z", "debit", "950.00", "Miete September", "Hausverwaltung Nord", "card", null],
    ["QM-1000-0008", "2026-09-30T07:00:00.000Z", "credit", "3400.00", "Gehalt September", "Elbwerk GmbH", "salary", null],

    // Dana - Notgroschen (EUR, frozen)
    ["QM-1000-0009", "2026-07-05T08:45:00.000Z", "credit", "10000.00", "Opening deposit", "Quillmoor Bank", "deposit", null],
  ],

  cards: [
    { account: "QM-1000-0001", last4: "4417", status: "active", expiresMonth: 7, expiresYear: 2030 },
    { account: "QM-1000-0003", last4: "9021", status: "frozen", expiresMonth: 8, expiresYear: 2030 },
    { account: "QM-1000-0004", last4: "3380", status: "active", expiresMonth: 7, expiresYear: 2030 },
    { account: "QM-1000-0008", last4: "6605", status: "active", expiresMonth: 7, expiresYear: 2030 },
  ],

  tickets: [
    {
      owner: "alice",
      subject: "Card declined at Lisbon airport",
      category: "cards",
      body: "My travel card was declined when I tried to pay for a taxi. Is it blocked?",
      createdAt: "2026-09-19T08:20:00.000Z",
    },
  ],
};
