import type {
  AssemblyListDto,
  AssemblySummaryDto,
  MemberDto,
  MemberRef,
} from "~~/shared/types/api";

/** Pages fetched at most for one filter list, so a runaway list stops. */
const MAX_OPTION_PAGES = 30;
/** GET /api/admin/users caps a page at 100. */
const ADMIN_USERS_PAGE_SIZE = 100;

/**
 * The assemblies the viewer sees, newest first, for the assembly filter.
 * GET /api/assemblies pages by 20, so every page is read once. Client-side
 * and lazy: the filter shows the URL's value until they arrive.
 */
export function useActivityAssemblies() {
  const api = useApi();
  const { data, status } = useLazyAsyncData<AssemblySummaryDto[]>(
    "activity-filter-assemblies",
    async () => {
      const items: AssemblySummaryDto[] = [];
      for (let page = 1; page <= MAX_OPTION_PAGES; page += 1) {
        const list = await api.get<AssemblyListDto>("/api/assemblies", {
          page,
        });
        items.push(...list.items);
        if (list.items.length === 0 || page * list.pageSize >= list.total) {
          break;
        }
      }
      return items;
    },
    { server: false, default: () => [] },
  );
  return { assemblies: data, status };
}

/**
 * Every member, inactive ones too, so a payload's member id or an old
 * filter still has a name.
 */
export function useActivityMembers() {
  const { t } = useI18n();
  const { data, status } = useLazyFetch<MemberDto[]>("/api/members", {
    key: "activity-filter-members",
    query: { all: 1 },
    server: false,
    default: () => [],
  });
  const byId = computed(
    () => new Map((data.value ?? []).map((member) => [member.id, member])),
  );
  /**
   * "CEUM"; a neutral "un miembro" while the list is still loading, and
   * null when the member is unknown.
   */
  function memberName(id: string): string | null {
    const member = byId.value.get(id);
    if (member) return member.acronym;
    return status.value === "success" || status.value === "error"
      ? null
      : t("activity.details.someMember");
  }
  return { members: data, status, byId, memberName };
}

/** An account as the admin filters list it. */
export interface ActivityDirectoryUser {
  id: string;
  /** coalesce(external name, Google name), as UserRef names it. */
  name: string;
  email: string;
  role: string | null;
  member: MemberRef | null;
}

interface AdminUsersPage {
  data: {
    id: string;
    name: string;
    email: string;
    externalName?: string | null;
    role: { id: string; name: string } | null;
    member?: MemberRef | null;
  }[];
  pagination: { hasNextPage: boolean };
}

/**
 * Every account (GET /api/admin/users, user:manage_roles), for the
 * account picker of the Admin's activity log. That endpoint has no search,
 * so all its pages are read once and the picker filters them.
 */
export function useActivityUserDirectory() {
  const api = useApi();
  const { data, status, error, refresh } = useLazyAsyncData<
    ActivityDirectoryUser[]
  >(
    "activity-filter-users",
    async () => {
      const users: ActivityDirectoryUser[] = [];
      for (let page = 1; page <= MAX_OPTION_PAGES; page += 1) {
        const result = await api.get<AdminUsersPage>("/api/admin/users", {
          page,
          pageSize: ADMIN_USERS_PAGE_SIZE,
        });
        for (const row of result.data) {
          users.push({
            id: row.id,
            name: row.externalName?.trim() || row.name || row.email,
            email: row.email,
            role: row.role?.name ?? null,
            member: row.member ?? null,
          });
        }
        if (!result.pagination.hasNextPage) break;
      }
      return users;
    },
    { server: false, default: () => [] },
  );
  const byId = computed(
    () => new Map((data.value ?? []).map((user) => [user.id, user])),
  );
  return { users: data, byId, status, error, refresh };
}
