import { buildActor, type Actor } from "../domain/actor";

/**
 * The export worker has no request, so it rebuilds the requester as an
 * `Actor` (domain/actor.ts, loadActorForUser). Visibility is evaluated when
 * the PDF is generated, with the requester's current role and member.
 */
export { loadActorForUser } from "../domain/actor";

/** Matches no account: better-auth ids are alphanumeric. */
const PUBLIC_READER_ID = "export:public-reader";

/**
 * Whoever reads only what is public: no role, member, permission or
 * account. The annotated PDF's marks and annex are built as this reader
 * sees them, whoever asks for it, so the file can go round (the Secretaría
 * files it with the minutes): only published amendments, and the executive
 * offices as the generic "CEA" (canSeeAmendment, visibleAcronym).
 */
export function publicExportActor(): Actor {
  return buildActor({
    user: {
      id: PUBLIC_READER_ID,
      name: "",
      email: "",
      image: null,
      roleId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: null,
      lastRoleSyncAt: null,
      role: null,
    },
    permissions: [],
    memberKind: null,
    impersonation: null,
  });
}
