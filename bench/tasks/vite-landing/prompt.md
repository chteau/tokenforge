Build the landing page for **Orbitly**, a (fictional) team planning app, as a new Vite + TypeScript project in this repository (the repository is currently empty apart from a README).

## Project requirements

- Use **Vite** and **TypeScript** (strict mode enabled). Vanilla TypeScript is preferred; a UI framework (React, Vue, Svelte, ...) is allowed if everything below still holds. Application code must be TypeScript, not plain JavaScript.
- `npm install` followed by `npm run build` must succeed and produce a static site in `dist/` (Vite's default output) that works when `dist/` is served from the web root.
- `package.json` must have a `typecheck` script that type-checks the whole project without emitting files (for example `tsc --noEmit`, or your framework's equivalent) and exits 0.
- Commit-ready project: keep `node_modules/` and `dist/` out of git. You may commit a lockfile.
- No `<script>` blocks containing code in `index.html` (only `<script type="module" src="...">` entry points).
- Do not rely on any external network resources at runtime (no CDN scripts, fonts or images).

The page is checked automatically in a real browser, so the `id`s, `data-testid` attributes and texts below must match **exactly** (texts are compared after trimming surrounding whitespace). Styling is up to you, but the page should look like a reasonable, responsive landing page.

## Page content and behaviour

**Document title**: `Orbitly — Plan less. Ship more.` (with an em dash).

**Header** — a `<header data-testid="site-header">` containing the brand name `Orbitly` and a `<nav>` with exactly these three links, in this order:

| text | href |
|---|---|
| `Features` | `#features` |
| `Pricing` | `#pricing` |
| `FAQ` | `#faq` |

The page must contain sections with `id="features"`, `id="pricing"` and `id="faq"`.

**Hero** — an element `data-testid="hero"` containing an `<h1>` with the text `Plan less. Ship more.` and a `<button data-testid="cta-button">` with the text `Get early access`.

**Signup modal**
- An element `data-testid="signup-modal"` with `role="dialog"` (a native `<dialog>` element is fine) that is **not visible** when the page loads (it may also be absent from the DOM until opened).
- Clicking the CTA button makes the modal visible.
- The modal contains a close button `data-testid="modal-close"`; clicking it hides the modal. Pressing the `Escape` key while the modal is open also hides it.
- The modal contains the signup form described below.

**Signup form** (inside the modal) — a `<form data-testid="signup-form">` with an input `data-testid="email-input"`, a submit button `data-testid="signup-submit"` and a message element `data-testid="form-message"`. Validation is done in your TypeScript code on submit (disable native browser validation, e.g. with `novalidate`, so your messages are always shown). Submitting must never reload the page. The email is first trimmed of surrounding whitespace, then:
- empty → message `Please enter your email address.` and the message element gets `data-state="error"`;
- not matching the pattern `something@something.something` (no whitespace, exactly one `@`, at least one `.` in the part after the `@`, with non-empty text on each side of that `.`) → message `Please enter a valid email address.` with `data-state="error"`;
- valid → message `Thanks! We'll be in touch at <email>.` where `<email>` is the trimmed email converted to lowercase (e.g. input `  Ada@Example.COM ` gives `Thanks! We'll be in touch at ada@example.com.`), `data-state="success"`, and the input is cleared.

**Features** — inside `#features`, render one element `data-testid="feature-card"` per entry of the following data, in this order. Each card contains the title in an `<h3>` and the description in a `<p>`. Keep the data in a TypeScript array and render the cards from it (do not hand-write each card's markup).

```ts
const features = [
  { title: "Shared timelines", description: "See every project and deadline on one calendar your whole team can edit." },
  { title: "Smart reminders", description: "Orbitly nudges the right person before a task slips, not after." },
  { title: "Workload balance", description: "Spot overloaded teammates at a glance and rebalance work in one drag." },
  { title: "Integrations", description: "Connect GitHub, Slack and Google Calendar in under a minute." },
  { title: "Reports that write themselves", description: "Weekly progress summaries land in your inbox every Monday." },
  { title: "Private by default", description: "Granular permissions keep client work visible only to the people on it." },
];
```

**Pricing** — inside `#pricing`:
- A billing toggle made of two buttons: `data-testid="billing-monthly"` (text `Monthly`) and `data-testid="billing-yearly"` (text `Yearly`). Exactly one is active at a time: the active button has `aria-pressed="true"`, the other `aria-pressed="false"`. Monthly is active on page load.
- Three plan cards `data-testid="plan-card"`, in this order, each with the plan name in an element `data-testid="plan-name"` and the price in an element `data-testid="plan-price"`:

| plan name | monthly price text | yearly price text |
|---|---|---|
| `Starter` | `$0/mo` | `$0/yr` |
| `Team` | `$12/mo` | `$120/yr` |
| `Business` | `$29/mo` | `$290/yr` |

  Clicking `Yearly` switches all three prices to the yearly text, clicking `Monthly` switches them back. Render the plans from data too.

**FAQ** — inside `#faq`, exactly three items `data-testid="faq-item"` in this order, each with a question element `data-testid="faq-question"` and an answer element `data-testid="faq-answer"`. Answers are hidden initially; clicking a question shows its answer (clicking again hides it). A `<details>`/`<summary>` pair is fine.

| question | answer |
|---|---|
| `Is there a free plan?` | `Yes. Starter is free forever for up to 3 people.` |
| `Can I cancel anytime?` | `Yes. Paid plans can be cancelled at any time from your settings.` |
| `Do you offer discounts for nonprofits?` | `Yes. Nonprofits get 50% off any paid plan.` |

**Footer** — a `<footer data-testid="site-footer">` containing an element `data-testid="copyright"` whose text is `© <year> Orbitly. All rights reserved.`, where `<year>` is the current year computed at runtime (not hard-coded).

Run `npm run build` and `npm run typecheck` before you finish and make sure both pass.
