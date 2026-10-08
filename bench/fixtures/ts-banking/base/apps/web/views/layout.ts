import { type SafeHtml, html } from "../html.ts";

export type NavKey = "dashboard" | "accounts" | "transfers" | "cards" | "notifications" | "support" | "none";

export interface LayoutModel {
  title: string;
  nav: NavKey;
  /** Omit for signed-out pages. */
  user?: { displayName: string; unreadNotifications?: number };
  flash?: { kind: "info" | "error"; message: string } | undefined;
  scripts?: string[];
}

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "dashboard", href: "/dashboard", label: "Overview" },
  { key: "accounts", href: "/accounts", label: "Accounts" },
  { key: "transfers", href: "/transfers", label: "Transfers" },
  { key: "cards", href: "/cards", label: "Cards" },
  { key: "notifications", href: "/notifications", label: "Inbox" },
];

export function layout(model: LayoutModel, content: SafeHtml): string {
  const { user } = model;
  const nav = user
    ? html`<nav class="main-nav" aria-label="Main">
        <ul>
          ${NAV.map(
            (item) => html`<li><a href="${item.href}"${item.key === model.nav ? html` aria-current="page"` : ""}>${item.label}${
              item.key === "notifications" && user.unreadNotifications
                ? html` <span class="pill">${user.unreadNotifications}</span>`
                : ""
            }</a></li>`,
          )}
        </ul>
        <form method="post" action="/logout" class="logout"><button type="submit">Sign out</button></form>
      </nav>`
    : "";
  const flash = model.flash
    ? html`<div class="flash flash-${model.flash.kind}" role="${model.flash.kind === "error" ? "alert" : "status"}">${model.flash.message}</div>`
    : "";
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${model.title} · Quillmoor Bank</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="${user ? "/dashboard" : "/login"}">Quillmoor<span>Bank</span></a>
    ${user ? html`<span class="greeting">Hello, ${user.displayName}</span>` : ""}
  </header>
  ${nav}
  <main id="content">
    ${flash}
    ${content}
  </main>
  <footer class="site-footer">Quillmoor Bank is a fictional bank used for demonstrations. No real money is involved.</footer>
  ${(model.scripts ?? []).map((src) => html`<script type="module" src="${src}"></script>`)}
</body>
</html>
`.value;
}
