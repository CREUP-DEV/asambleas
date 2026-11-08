import type { Ref } from "vue";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AgendaDto } from "~~/shared/types/api";
import {
  ADD_AFTER_QUERY,
  addAfterOf,
  nextItemId,
} from "~/composables/document/agendaReturn";

/**
 * The new-document modal of a hub page (home, agenda): who may add, under
 * which items, and the "Añadir documento" / "Presentar documento" button.
 *
 * - The button only shows while documents can be presented: the assembly is
 *   not closed and the calendar's "documents_close" has not passed (shared
 *   clock, so it goes away on time in a tab left open). Managers
 *   (document:manage) add under any item; members, for their own member,
 *   under the items that take submissions.
 * - `?nuevo=<item>` (the editor's "… y añadir otro") opens the modal on the
 *   item after that one and is then dropped from the address. It works for
 *   managers outside the window too, as the agenda's own buttons do.
 */
export function useAddDocument(agenda: Ref<AgendaDto | null | undefined>) {
  const me = useMe();
  const { assembly } = useCurrentAssembly();
  const now = useAppNow();
  const route = useRoute();
  const router = useRouter();

  const manager = computed(() => me.can(PERMISSION_KEYS.DOCUMENT_MANAGE));

  /** Documents can be presented now (status and calendar). */
  const windowOpen = computed(() => {
    const value = assembly.value;
    if (!value || value.status === "closed") return false;
    const close = value.milestones.find(
      (milestone) => milestone.key === "documents_close",
    );
    return !close || new Date(close.at).getTime() > now.value;
  });

  /** Every item in agenda order, numbered as on the agenda. */
  const items = computed(() => {
    const rows = agenda.value?.items ?? [];
    const withDocuments = new Set(
      (agenda.value?.documents ?? []).map((document) => document.agendaItemId),
    );
    const numbers = agendaNumbers(rows);
    return flattenAgendaTree(buildAgendaTree(rows)).map(({ item }) => ({
      id: item.id,
      title: item.title,
      number: numbers.get(item.id) ?? "",
      acceptsSubmissions: item.acceptsSubmissions,
      hasDocuments: withDocuments.has(item.id),
    }));
  });

  /** A member presenting for its own member. */
  const memberCanPresent = computed(
    () =>
      Boolean(assembly.value?.can.createDocuments) &&
      Boolean(me.member.value) &&
      items.value.some((item) => item.acceptsSubmissions),
  );

  /** The button at the top of the page. */
  const canAdd = computed(
    () => windowOpen.value && (manager.value || memberCanPresent.value),
  );

  const open = ref(false);
  const itemId = ref<string | null>(null);
  const mode = ref<"manager" | "member">(manager.value ? "manager" : "member");

  function openFor(
    id: string | null,
    as: "manager" | "member" = manager.value ? "manager" : "member",
  ): void {
    itemId.value = id;
    mode.value = as;
    open.value = true;
  }

  /** Open the modal on the item after `after`, as "… y añadir otro" asks. */
  function openAfter(after: string): void {
    const asManager = manager.value;
    if (!asManager && !canAdd.value) return;
    const ids = items.value
      .filter((item) => asManager || item.acceptsSubmissions)
      .map((item) => item.id);
    openFor(nextItemId(ids, after));
  }

  onMounted(() => {
    const after = addAfterOf(route.query);
    if (!after) return;
    openAfter(after);
    const query = Object.fromEntries(
      Object.entries(route.query).filter(([key]) => key !== ADD_AFTER_QUERY),
    );
    void router.replace({ query, hash: route.hash });
  });

  return { canAdd, items, open, itemId, mode, openFor, manager };
}
