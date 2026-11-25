import type { Ref } from "vue";
import type { DocumentKind } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AgendaDto } from "~~/shared/types/api";
import {
  ADD_AFTER_QUERY,
  addAfterOf,
  nextItemId,
} from "~/composables/document/agendaReturn";
import { memberSubmissionKinds } from "~/composables/document/documentKinds";
import { usePresentationDeadlines } from "~/composables/document/usePresentationDeadlines";

/**
 * The new-document modal of a hub page (home, agenda): who may add, under
 * which items, and the "Añadir documento" / "Presentar documento" button.
 *
 * - Managers (document:manage) get the button until the assembly closes,
 *   whatever the calendar says, as the server lets them add documents at
 *   any time, and add under any item. Members get it only while documents
 *   can be presented: the assembly is not closed and some kind is still in
 *   its own deadline (presentationDeadlinePassed, on the shared clock, so it
 *   goes away on time in a tab left open), for their own member, under the
 *   items that take a kind their member may present whose deadline has not
 *   passed (a candidacy until `candidacies_close`, a report until
 *   `reports_close`, the rest until `documents_close`), the same rule the
 *   server applies to creating and to sending the draft. Nobody adds under
 *   an automatic sub-item (the one the server creates for each document
 *   presented under such an item): the document goes to the item above, and
 *   gets its own.
 * - `?nuevo=<item>` (the editor's "… y añadir otro") opens the modal on the
 *   next item without documents after that one (nextItemId) and is then
 *   dropped from the address. After a document in an automatic sub-item it
 *   opens on the item above again, which takes the next one too. It works
 *   for managers outside the window too, as the agenda's own buttons do.
 * - It hands the page the same deadlines (`kindOpen`, `schedule`:
 *   usePresentationDeadlines) for what the page says about them. A member's
 *   `schedule` reads only the kinds it may present under some item
 *   (memberSubmissionKinds), so the overview counts down to its own
 *   deadline; managers, and a member before the agenda loads, read every
 *   kind.
 */
export function useAddDocument(agenda: Ref<AgendaDto | null | undefined>) {
  const me = useMe();
  const { assembly } = useCurrentAssembly();
  const route = useRoute();
  const router = useRouter();

  const manager = computed(() => me.can(PERMISSION_KEYS.DOCUMENT_MANAGE));

  /** The kinds a member may present under some item (null: every kind). */
  const ownKinds = computed<DocumentKind[] | null>(() => {
    if (manager.value) return null;
    const kinds = new Set<DocumentKind>();
    for (const item of agenda.value?.items ?? []) {
      for (const kind of memberSubmissionKinds(item, me.member.value?.kind)) {
        kinds.add(kind);
      }
    }
    return [...kinds];
  });

  const { kindOpen, schedule } = usePresentationDeadlines(assembly, ownKinds);

  /** The assembly still takes documents from managers. */
  const assemblyOpen = computed(
    () => !!assembly.value && assembly.value.status !== "closed",
  );

  /**
   * Members can present documents now: the assembly is open and some kind
   * is still in its own deadline (presentationDeadlinePassed).
   */
  const windowOpen = computed(() => assemblyOpen.value && schedule.value.open);

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
        : memberSubmissionKinds(item, me.member.value?.kind).some(kindOpen),
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
  const canAdd = computed(() =>
    manager.value
      ? assemblyOpen.value
      : windowOpen.value && memberCanPresent.value,
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

  return {
    canAdd,
    items,
    open,
    itemId,
    mode,
    openFor,
    manager,
    kindOpen,
    schedule,
  };
}
