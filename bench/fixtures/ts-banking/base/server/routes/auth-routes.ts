import { parseOrThrow, v } from "../../packages/shared/src/validation.ts";
import { json, noContent } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api, publicApi } from "./helpers.ts";

const loginSchema = v.object({
  username: v.string({ min: 1, max: 64 }),
  password: v.string({ min: 1, max: 256, trim: false }),
});

const profileSchema = v.object({
  displayName: v.optional(v.string({ min: 1, max: 80 })),
  timezone: v.optional(v.timeZone()),
  emailNotifications: v.optional(v.boolean()),
});

const passwordSchema = v.object({
  currentPassword: v.string({ min: 1, trim: false }),
  newPassword: v.string({ min: 1, max: 256, trim: false }),
});

export function authRoutes(): Route[] {
  return [
    publicApi("POST", "/api/auth/login", async (ctx) => {
      const input = parseOrThrow(loginSchema, ctx.body);
      const result = await ctx.deps.services.auth.login(input.username, input.password);
      return json(200, result);
    }),

    api("POST", "/api/auth/logout", "user", (ctx) => {
      if (ctx.sessionToken) ctx.deps.services.auth.logout(ctx.sessionToken);
      return noContent();
    }),

    api("GET", "/api/me", "user", (ctx) => json(200, { user: ctx.deps.services.auth.me(ctx.actor) })),

    api("PATCH", "/api/me", "user", (ctx) => {
      const input = parseOrThrow(profileSchema, ctx.body);
      return json(200, { user: ctx.deps.services.auth.updateProfile(ctx.actor, input) });
    }),

    api("POST", "/api/me/password", "user", async (ctx) => {
      const input = parseOrThrow(passwordSchema, ctx.body);
      await ctx.deps.services.auth.changePassword(ctx.actor, input.currentPassword, input.newPassword);
      return noContent();
    }),
  ];
}
