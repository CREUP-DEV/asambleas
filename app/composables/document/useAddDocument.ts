import type { Ref } from "vue";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AgendaDto } from "~~/shared/types/api";
import {
  ADD_AFTER_QUERY,
  addAfterOf,
  nextItemId,
} from "~/composables/document/agendaReturn";
import { memberSubmissionKinds } from "~/composables/document/documentKinds";

/**
 * The new-document modal of a hub page (home, agenda): who may add, under
 * which items, and the "Añadir documento" / "Presentar documento" button.
 *
 * - The button only shows while documents can be presented: the assembly is
 *   not closed and the calendar's "documents_close" has not passed (shared
 *   clock, so it goes away on time in a tab left open). Managers
 *   (document:manage) add under any item; members, for their own member,
 *   under the items that take submissions of a kind their member may
 *   present. Nobody adds under an automatic sub-item (the one the server
 *   creates for each document presented under such an item): the document
 *   goes to the item above, and gets its own.
 * - `?nuevo=<item>` (the editor's "… y añadir otro") opens the modal on the
 *   next item without documents after that one (nextItemId) and is then
 *   dropped from the address. After a document in an automatic sub-item it
 *   opens on the item above again, which takes the next one too. It works
 *   for managers outside the window too, as the agenda's own buttons do.
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
      number: numbers.get(item.id) ?? null,
      acceptsSubmissions: item.acceptsSubmissions,
      submissionKinds: item.submissionKinds,
      auto: item.auto,
      parentId: item.parentId,
      hasDocuments: withDocuments.has(item.id),
    }));
  });

  /** The items the user may add a document under. */
  const pickable = computed(() =>
    items.value.filter((item) =>
      manager.value
        ? !item.auto
        : memberSubmissionKinds(item, me.member.value?.kind).length > 0,
    ),
  );

  /** A member presenting for its own member. */
  const memberCanPresent = computed(
    () =>
      Boolean(assembly.value?.can.createDocuments) &&
      Boolean(me.member.value) &&
      pickable.value.length > 0,
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
    if (!manager.value && !canAdd.value) return;
    // A document presented under an item that takes several sits in its own
    // sub-item: the next one goes to the item above again.
    const previous = items.value.find((item) => item.id === after);
    if (previous?.auto && previous.parentId) {
      const container = pickable.value.find(
        (item) => item.id === previous.parentId,
      );
      if (container) {
        openFor(container.id);
        return;
      }
    }
    openFor(nextItemId(pickable.value, after));
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
