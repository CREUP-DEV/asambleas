import type { MemberDto } from "~~/shared/types/api";

/**
 * Every member the account may read (GET /api/members?all=1, with the
 * offices collapsed into the generic "CEA" for whoever may not see them),
 * by id, for the cards an acronym opens on hover (CommonMemberCard): a
 * council's university and acronym, who holds a CEA office. Fetched once
 * per page load, the first time a card asks for it; nothing before.
 */
export function useMemberDirectory() {
  const api = useApi();
  const members = useState<MemberDto[] | null>("member-directory", () => null);
  const loading = useState<boolean>("member-directory-loading", () => false);

  const byId = computed(
    () => new Map((members.value ?? []).map((member) => [member.id, member])),
  );

  async function load(): Promise<void> {
    if (members.value || loading.value || import.meta.server) return;
    loading.value = true;
    try {
      members.value = await api.get<MemberDto[]>("/api/members", { all: 1 });
    } catch {
      // The card shows what the acronym carries; the next card tries again.
    } finally {
      loading.value = false;
    }
  }

  return { byId, load };
}
