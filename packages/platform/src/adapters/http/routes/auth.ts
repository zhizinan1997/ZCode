/** /api/auth/*：登录、登出、当前用户、改密。 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import { toPublicUser } from "../../../domain/user.js";
import { readJsonObject, readString, requireAuth } from "../helpers.js";

export function createAuthRoutes(accounts: AccountService): Hono {
  const routes = new Hono();

  routes.post("/login", async (context) => {
    const body = await readJsonObject(context);
    const email = readString(body, "email", { required: true, maxLength: 254 });
    const password = readString(body, "password", { required: true, maxLength: 200 });
    const result = await accounts.login({
      email,
      password,
      userAgent: context.req.header("user-agent"),
    });
    return context.json({
      token: result.token,
      expiresAt: result.expiresAt,
      user: toPublicUser(result.user),
    });
  });

  routes.post("/logout", async (context) => {
    const session = await requireAuth(context, accounts);
    await accounts.logout(session.session.id);
    return context.body(null, 204);
  });

  routes.get("/me", async (context) => {
    const session = await requireAuth(context, accounts);
    return context.json({
      user: toPublicUser(session.user),
      expiresAt: session.session.expiresAt,
    });
  });

  routes.post("/password", async (context) => {
    const session = await requireAuth(context, accounts);
    const body = await readJsonObject(context);
    const currentPassword = readString(body, "currentPassword", {
      required: true,
      maxLength: 200,
      label: "当前密码",
    });
    const newPassword = readString(body, "newPassword", {
      required: true,
      maxLength: 200,
      label: "新密码",
    });
    await accounts.changePassword({
      userId: session.user.id,
      currentPassword,
      newPassword,
      keepSessionId: session.session.id,
    });
    return context.body(null, 204);
  });

  return routes;
}
