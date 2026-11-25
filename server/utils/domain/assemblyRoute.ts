import type { H3Event } from "h3";
import { getRouterParam } from "h3";
import { requireActor, type Actor } from "./actor";
import { resolveAssembly } from "./resolvers";
import { requireViewer } from "./roomView";

/**
 * The opening of every route under /api/assemblies/[assembly] that works at
 * the assembly's level: the actor first (requireActor, or requireViewer
 * with `viewer` for a read the projection makes, so `?view=room` answers as
 * the room), then the assembly of the `[assembly]` param as that actor sees
 * it (resolveAssembly: 404 when hidden or malformed). The route checks its
 * permission next, with requireCan or a named guard. Routes below a
 * document or an amendment open with their own loader instead
 * (resolveDocumentRoute, loadAmendmentContext,
 * loadAmendmentDocumentContext), which does this too.
 *
 * It lives apart from resolvers.ts so that resolvers.ts never imports
 * roomView.ts (roomView -> assemblies -> documents -> resolvers would
 * close a cycle).
 */
export async function resolveAssemblyRoute(
  event: H3Event,
  options: { viewer?: boolean } = {},
): Promise<{
  actor: Actor;
  assembly: Awaited<ReturnType<typeof resolveAssembly>>;
}> {
  const actor = options.viewer
    ? await requireViewer(event)
    : await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return { actor, assembly };
}
