import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../server/db/schema";
import { requireConfigString } from "../shared/utils/config";
import { SYSTEM_ROLES, SYSTEM_ROLE_NAMES } from "../shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_DESCRIPTION_I18N_KEYS,
} from "../shared/constants/permissions";

const connectionString = requireConfigString(
  process.env.DATABASE_URL,
  "DATABASE_URL",
);

const db = drizzle(connectionString, { schema });

const ROLE_DESCRIPTIONS: Record<string, string> = {
  [SYSTEM_ROLES.ADMIN]: "Acceso completo a todas las funciones del sistema",
  [SYSTEM_ROLES.SECRETARIA]:
    "Gestiona asambleas, documentos y revisión de enmiendas",
  [SYSTEM_ROLES.MODERADOR]: "Modera el desarrollo de asambleas",
  [SYSTEM_ROLES.ASOCIADO]: "Presenta documentos y enmiendas",
  [SYSTEM_ROLES.INVITADO]: "Solo lectura de contenido publicado",
};

async function seed() {
  console.log("Seeding roles...");

  const roleRecords = await db
    .insert(schema.roles)
    .values(
      SYSTEM_ROLE_NAMES.map((name) => ({
        name,
        description: ROLE_DESCRIPTIONS[name] ?? null,
        isSystem: true,
      })),
    )
    .onConflictDoUpdate({
      target: schema.roles.name,
      set: {
        description: sql`excluded.description`,
        isSystem: sql`excluded.is_system`,
      },
    })
    .returning({ id: schema.roles.id, name: schema.roles.name });

  console.log(`  ${roleRecords.length} roles upserted`);

  console.log("Seeding permissions...");

  const permissionRecords = await db
    .insert(schema.permissions)
    .values(
      ALL_PERMISSION_KEYS.map((key) => ({
        key,
        description: PERMISSION_DESCRIPTION_I18N_KEYS[key] ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: schema.permissions.key,
      set: {
        description: sql`excluded.description`,
      },
    })
    .returning({ id: schema.permissions.id, key: schema.permissions.key });

  console.log(`  ${permissionRecords.length} permissions upserted`);

  console.log("Seeding role-permission assignments...");

  const allRoles = await db.query.roles.findMany({
    columns: { id: true, name: true },
  });

  const allPermissions = await db.query.permissions.findMany({
    columns: { id: true, key: true },
  });

  const roleByName = Object.fromEntries(allRoles.map((r) => [r.name, r.id]));
  const permissionByKey = Object.fromEntries(
    allPermissions.map((p) => [p.key, p.id]),
  );

  const assignments: { roleId: string; permissionId: string }[] = [];

  for (const [roleName, permissionKeys] of Object.entries(
    DEFAULT_ROLE_PERMISSIONS,
  )) {
    const roleId = roleByName[roleName];
    if (!roleId) continue;

    for (const key of permissionKeys) {
      const permissionId = permissionByKey[key];
      if (!permissionId) continue;
      assignments.push({ roleId, permissionId });
    }
  }

  if (assignments.length > 0) {
    const inserted = await db
      .insert(schema.rolePermissions)
      .values(assignments)
      .onConflictDoNothing()
      .returning({ id: schema.rolePermissions.id });

    console.log(
      `  ${inserted.length} role-permission assignments created (skipped existing)`,
    );
  } else {
    console.log("  No assignments to create");
  }

  console.log("Seed complete.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
