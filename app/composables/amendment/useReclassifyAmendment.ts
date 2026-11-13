import type { AmendmentDto, ReclassifyBody } from "~~/shared/types/api";
import { reclassifyTarget } from "~~/shared/utils/amendmentReclassify";

/**
 * Moves an amendment between "de forma" and "de contenido" (POST
 * .../[amendment]/reclassify, optimistic lock on `updatedAt`), with the toast
 * that says so. The detail panel (AmendmentReclassify) and the validation
 * inbox share it. Resolves to the amendment as the server returns it, or
 * null when it failed (already notified); `conflict` is true when someone
 * changed it meanwhile, so the caller refetches.
 */
export function useReclassifyAmendment() {
  const { t } = useI18n();
  const api = useApi();
  const toast = useToast();

  async function reclassify(
    amendment: Pick<AmendmentDto, "kind" | "updatedAt">,
    /** URL of the amendment: .../amendments/{id}. */
    url: string,
  ): Promise<{ updated: AmendmentDto | null; conflict: boolean }> {
    const kind = reclassifyTarget(amendment.kind);
    if (!kind) return { updated: null, conflict: false };
    try {
      const body: ReclassifyBody = { kind, updatedAt: amendment.updatedAt };
      const updated = await api.send<AmendmentDto>(`${url}/reclassify`, {
        method: "POST",
        body,
      });
      toast.add({
        title: t(`amendment.reclassify.done.${kind}`),
        description: t("amendment.reclassify.doneDescription"),
        color: "success",
        icon: "i-lucide-tags",
      });
      return { updated, conflict: false };
    } catch (error) {
      api.notifyError(error, "amendment.reclassify.failed");
      return { updated: null, conflict: api.isConflict(error) };
    }
  }

  return { reclassify };
}
