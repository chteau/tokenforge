// Server-side HTML templating. Interpolated values are escaped unless they are
// SafeHtml (produced by `html` itself or `raw`). Views are pure functions that
// return strings; they never touch services or the request.

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

type Interpolation = SafeHtml | string | number | boolean | null | undefined | readonly Interpolation[];

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? "");
  });
  return new SafeHtml(out);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Build a query string from defined, non-empty values: { a: "1", b: "" } -> "?a=1". */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export function attr(name: string, on: boolean): SafeHtml {
  return on ? raw(` ${name}`) : raw("");
}
