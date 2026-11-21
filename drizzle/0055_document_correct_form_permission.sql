-- document:correct_form (user's decision of 2026-11-21): correcting the
-- form of an approved text directly. Added here rather than through the
-- RBAC seed, which would also put back every default grant removed by
-- hand. Whoever could correct before keeps it: every role, and every user
-- grant, holding document:manage or session:moderate.
INSERT INTO "permissions" ("id", "key", "description")
VALUES (
  replace(gen_random_uuid()::text, '-', ''),
  'document:correct_form',
  'permissions.descriptions.documentCorrectForm'
)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT DISTINCT ON (rp."role_id")
  replace(gen_random_uuid()::text, '-', ''),
  rp."role_id",
  target."id"
FROM "role_permissions" rp
JOIN "permissions" source ON source."id" = rp."permission_id"
CROSS JOIN "permissions" target
WHERE source."key" IN ('document:manage', 'session:moderate')
  AND target."key" = 'document:correct_form'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "user_permissions" ("id", "user_id", "permission_id")
SELECT DISTINCT ON (up."user_id")
  replace(gen_random_uuid()::text, '-', ''),
  up."user_id",
  target."id"
FROM "user_permissions" up
JOIN "permissions" source ON source."id" = up."permission_id"
CROSS JOIN "permissions" target
WHERE source."key" IN ('document:manage', 'session:moderate')
  AND target."key" = 'document:correct_form'
ON CONFLICT ("user_id", "permission_id") DO NOTHING;
