import { html } from "../html.ts";
import { layout } from "./layout.ts";

export function renderLoginPage(model: { username?: string; error?: string; next?: string }): string {
  return layout(
    { title: "Sign in", nav: "none", flash: model.error ? { kind: "error", message: model.error } : undefined },
    html`<section class="card narrow">
      <h1>Sign in to online banking</h1>
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="next" value="${model.next ?? "/dashboard"}">
        <label>Username <input name="username" autocomplete="username" required value="${model.username ?? ""}"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit" class="primary">Sign in</button>
      </form>
    </section>`,
  );
}
