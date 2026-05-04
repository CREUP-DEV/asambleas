import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { auth } from "./auth";
import type { PermissionKey } from "~~/shared/constants/permissions";

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export interface AuthUserWithRole {
  id: string;
  name: string;
  email: string;
  image: string | null;
  roleId: string | null;
  externalRole: string | null;
  externalName: string | null;
  externalInitials: string | null;
  university: string | null;
  lastRoleSyncAt: Date | null;
  role: {
    id: string;
    name: string;
  } | null;
}

export interface AuthEventContext {
  session?: AuthSession;
  user?: AuthUserWithRole;
  role?: AuthUserWithRole["role"];
  permissions?: PermissionKey[];
}

export async function requireAuth(event: H3Event) {
  const context = event.context as AuthEventContext;

  if (context.session) {
    return context.session;
  }

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({
      statusCode: 401,
      message: "No autorizado",
    });
  }

  context.session = session;
  return session;
}

export async function getAuthUserWithRole(
  event: H3Event,
): Promise<AuthUserWithRole | null> {
  const context = event.context as AuthEventContext;

  if (context.user) {
    return context.user;
  }

  const session = await requireAuth(event);
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      roleId: true,
      externalRole: true,
      externalName: true,
      externalInitials: true,
      university: true,
      lastRoleSyncAt: true,
    },
    with: {
      role: { columns: { id: true, name: true } },
    },
  });

  if (user) {
    context.user = user;
    context.role = user.role;
  }

  return user ?? null;
}
