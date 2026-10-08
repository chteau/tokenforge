import { html } from "../html.ts";
import { layout } from "./layout.ts";

const TITLES: Record<number, string> = {
  400: "That request didn't look right",
  403: "You don't have access to this page",
  404: "We couldn't find that page",
  409: "That action conflicts with the current state",
  422: "We couldn't complete that action",
  429: "Slow down a little",
  500: "Something went wrong",
};

export function renderErrorPage(model: { status: number; message: string; actorPresent: boolean }): string {
  const title = TITLES[model.status] ?? "Something went wrong";
  return layout(
    { title, nav: "none" },
    html`<section class="error-page">
      <h1>${title}</h1>
      <p>${model.message}</p>
      <p><a href="${model.actorPresent ? "/dashboard" : "/login"}">Back to safety</a></p>
    </section>`,
  );
}
