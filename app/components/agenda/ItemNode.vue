<script lang="ts">
import type { InjectionKey, Ref } from "vue";
import type { AgendaItemDto, DocumentSummaryDto } from "~~/shared/types/api";
import type { AgendaMove, AgendaTreeNode } from "~/utils/agendaTree";
import {
  agendaItemAnchor,
  agendaItemPath,
} from "~/composables/document/agendaReturn";
import { memberSubmissionKinds } from "~/composables/document/documentKinds";

/** What the agenda page shares with every (recursive) item node. */
export interface AgendaTreeContext {
  /** The actor manages the assembly (edit, move, delete items). */
  manage: Readonly<Ref<boolean>>;
  /**
   * The page is in "Organizar orden del día" mode: the editing controls
   * (move, add, edit, delete) show on every item. Off,
   * the agenda stays a clean list of items and documents.
   */
  organizing: Readonly<Ref<boolean>>;
  /**
   * Whether the sub-items of an item are folded (hidden). Always false in
   * organize mode, which shows the whole tree.
   */
  isCollapsed: (itemId: string) => boolean;
  /** Folds or unfolds the sub-items of an item. */
  toggleFold: (itemId: string) => void;
  /** The actor creates documents as a manager anywhere. */
  canCreateDocument: Readonly<Ref<boolean>>;
  /** The actor may present a document as a member right now. */
  canSubmitDocument: Readonly<Ref<boolean>>;
  /** Item with a request in flight. */
  busyId: Readonly<Ref<string | null>>;
  documentsFor: (itemId: string) => DocumentSummaryDto[];
  documentPath: (document: DocumentSummaryDto) => string;
  /** Where the presenter prepares their own draft, if they can. */
  documentEditPath: (document: DocumentSummaryDto) => string | null;
  canMove: (itemId: string, move: AgendaMove) => boolean;
  move: (itemId: string, move: AgendaMove) => void;
  /**
   * No longer used: editing, adding a sub-item, deleting and who presents
   * under an item belong to AgendaItemManageBar and the item form. Optional
   * so a page may stop providing them.
   */
  canDelete?: (itemId: string) => boolean;
  edit?: (item: AgendaItemDto) => void;
  addChild?: (node: AgendaTreeNode<AgendaItemDto>) => void;
  remove?: (node: AgendaTreeNode<AgendaItemDto>) => void;
  toggleSubmissions?: (item: AgendaItemDto, value: boolean) => void;
  newDocument: (
    node: AgendaTreeNode<AgendaItemDto>,
    mode: "manager" | "member",
  ) => void;
}

export const AGENDA_TREE_CONTEXT: InjectionKey<AgendaTreeContext> =
  Symbol("agenda-tree");

/** DOM id of an item's heading (focus target and anchor). */
export { agendaItemAnchor };

/** DOM id of the list of an item's sub-items (what its fold button controls). */
export function agendaChildrenId(itemId: string): string {
  return `agenda-children-${itemId}`;
}
</script>

<script setup lang="ts">
/**
 * One agenda item with its documents and its sub-items, rendered recursively
 * as nested ordered lists. By default it shows only the numbered title, the
 * description, the documents (compact rows) and, for members, "Presentar
 * documento". An item with sub-items has a button that shows or hides them.
 * The title of an item opens its own page (orden-del-dia/[item]).
 * An item whose only document is called the same shows one row: its title
 * opens the document and carries its status and amendment count
 * (mergedAgendaDocument), with a small link to the item's page when it has
 * sub-items. The editing controls (move, add document and the item's
 * actions as buttons with their text: AgendaItemManageBar) appear only while
 * the page is in organize mode, which shows every item unfolded and item
 * and document apart, and says what members present under each item.
 * An item that is not in the agenda for everyone yet (`unlisted`) shows a
 * neutral mark where its number would be (AgendaItemNumber) and its labels
 * say so instead of a number; everything else works the same.
 */
defineOptions({ name: "AgendaItemNode" });

const props = defineProps<{
  node: AgendaTreeNode<AgendaItemDto>;
}>();

const { t } = useI18n();

const context = inject(AGENDA_TREE_CONTEXT);
if (!context) {
  throw new Error("AgendaItemNode needs the agenda tree context");
}
const ctx = context;

const item = computed(() => props.node.item);
const busy = computed(() => ctx.busyId.value === item.value.id);
const documents = computed(() => ctx.documentsFor(item.value.id));
const headingLevel = computed(() => (props.node.depth === 0 ? "h3" : "h4"));

/** The item's own page: its title leads there. */
const { sectionPath } = useCurrentAssembly();
const itemPath = computed(() => agendaItemPath(sectionPath(), item.value.id));

const MOVES: { move: AgendaMove; icon: string }[] = [
  { move: "up", icon: "i-lucide-arrow-up" },
  { move: "down", icon: "i-lucide-arrow-down" },
  { move: "outdent", icon: "i-lucide-indent-decrease" },
  { move: "indent", icon: "i-lucide-indent-increase" },
];

/**
 * What stands for the number in the labels about the item: the number, or
 * the words for an item that has none (not in the agenda for everyone yet).
 */
const numberText = computed(() =>
  agendaNumberInText(props.node.number, t("agenda.unlisted.inText")),
);

const moveLabel = (move: AgendaMove) =>
  t(`agenda.move.${move}`, {
    number: numberText.value,
    title: item.value.title,
  });

const organizing = computed(() => ctx.organizing.value);
const showItemControls = computed(() => organizing.value && ctx.manage.value);
const showAddDocument = computed(
  () => organizing.value && ctx.canCreateDocument.value,
);

/** The only document, shown in the item's own row when called the same. */
const merged = computed(() =>
  organizing.value
    ? null
    : mergedAgendaDocument(item.value.title, documents.value),
);

// Folding: organize mode shows the whole tree and has no fold buttons.
const childCount = computed(() => props.node.children.length);
const foldable = computed(() => childCount.value > 0 && !organizing.value);
const collapsed = computed(
  () => foldable.value && ctx.isCollapsed(item.value.id),
);
const foldLabel = computed(() =>
  t(
    collapsed.value ? "agenda.fold.show" : "agenda.fold.hide",
    { count: childCount.value },
    childCount.value,
  ),
);

/**
 * A member may present a document here right now: the item takes a kind
 * their member may present (a sectorial, never an internal motion).
 */
const { member } = useMe();
const showMemberSubmit = computed(
  () =>
    !organizing.value &&
    memberSubmissionKinds(item.value, member.value?.kind).length > 0 &&
    !ctx.canCreateDocument.value &&
    ctx.canSubmitDocument.value,
);

/**
 * Organize mode: what members present under the item, in words. It is
 * changed in the item form ("Editar").
 */
const containerLabel = computed(() => {
  if (!item.value.acceptsSubmissions) return null;
  const kinds = item.value.submissionKinds;
  return kinds.length === 0
    ? t("agenda.container.takesAll")
    : t("agenda.container.takesKinds", {
        kinds: kinds
          .map((kind) => t(`agenda.documentKinds.${kind}`))
          .join(", "),
      });
});
</script>

<template>
  <li class="space-y-3" :data-agenda-item="item.id">
    <div
      class="border-default bg-default rounded-lg border p-3 sm:p-4"
      :class="{ 'ring-primary/40 ring-2': busy }"
      :aria-busy="busy || undefined"
    >
      <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
        <component
          :is="headingLevel"
          :id="agendaItemAnchor(item.id)"
          tabindex="-1"
          class="text-highlighted min-w-0 flex-1 scroll-mt-24 font-semibold focus-visible:outline-none"
          :class="
            node.depth === 0 ? 'text-base sm:text-lg' : 'text-sm sm:text-base'
          "
        >
          <AgendaItemNumber :number="node.number" class="text-primary me-2" />
          <NuxtLink
            v-if="merged"
            :to="ctx.documentPath(merged)"
            class="focus-visible:outline-primary rounded-sm break-words hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            data-testid="agenda-merged-document"
          >
            {{ item.title }}
          </NuxtLink>
          <NuxtLink
            v-else
            :to="itemPath"
            class="focus-visible:outline-primary rounded-sm break-words hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            data-testid="agenda-item-link"
          >
            {{ item.title }}
          </NuxtLink>
        </component>

        <!-- The title opens the document: the item's page, for its sub-items -->
        <UButton
          v-if="merged && childCount > 0"
          :to="itemPath"
          color="neutral"
          variant="link"
          size="xs"
          class="px-0"
          trailing-icon="i-lucide-arrow-right"
          :label="t('agenda.item.open')"
          :aria-label="
            t('agenda.item.openOf', {
              number: numberText,
              title: item.title,
            })
          "
          data-testid="agenda-merged-item-link"
        />

        <AgendaDocumentBadges
          v-if="merged"
          :document="merged"
          :edit-to="ctx.documentEditPath(merged)"
        />

        <UButton
          v-if="showMemberSubmit"
          size="sm"
          icon="i-lucide-file-up"
          :label="t('agenda.actions.submitDocument')"
          :aria-label="
            t('agenda.actions.submitDocumentIn', {
              number: numberText,
              title: item.title,
            })
          "
          @click="ctx.newDocument(node, 'member')"
        />
      </div>

      <p
        v-if="item.description"
        class="text-muted mt-1 text-sm whitespace-pre-line"
      >
        {{ item.description }}
      </p>

      <!-- Organize mode: editing controls -->
      <div
        v-if="showItemControls || showAddDocument"
        class="border-default mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3"
      >
        <UFieldGroup
          v-if="showItemControls"
          size="xs"
          :aria-label="t('agenda.move.group')"
          role="group"
        >
          <UTooltip
            v-for="entry in MOVES"
            :key="entry.move"
            :text="t(`agenda.move.${entry.move}Short`)"
          >
            <UButton
              color="neutral"
              variant="outline"
              :icon="entry.icon"
              :aria-label="moveLabel(entry.move)"
              :data-agenda-move="`${item.id}:${entry.move}`"
              :disabled="!ctx.canMove(item.id, entry.move)"
              @click="ctx.move(item.id, entry.move)"
            />
          </UTooltip>
        </UFieldGroup>

        <p
          v-if="containerLabel"
          class="text-muted flex items-center gap-1.5 text-xs"
          data-testid="agenda-container-label"
        >
          <UIcon
            name="i-lucide-inbox"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ containerLabel }}</span>
        </p>

        <div class="ms-auto flex flex-wrap items-center justify-end gap-2">
          <UButton
            v-if="showAddDocument && !item.auto"
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-file-plus"
            :label="t('agenda.actions.newDocument')"
            :aria-label="
              t('agenda.actions.newDocumentIn', {
                number: numberText,
                title: item.title,
              })
            "
            @click="ctx.newDocument(node, 'manager')"
          />
          <!-- Editar, Añadir subpunto, Añadir documentos, Eliminar -->
          <AgendaItemManageBar :item="node" compact />
        </div>
      </div>

      <!-- Documents -->
      <ul
        v-if="documents.length > 0 && !merged"
        class="mt-3 space-y-2"
        :aria-label="
          t('agenda.documentsOf', { number: numberText, title: item.title })
        "
      >
        <li v-for="document in documents" :key="document.id">
          <AgendaDocumentRow
            :document="document"
            :to="ctx.documentPath(document)"
            :edit-to="ctx.documentEditPath(document)"
            :compact="!organizing"
          />
        </li>
      </ul>
    </div>

    <UButton
      v-if="foldable"
      color="neutral"
      variant="ghost"
      size="xs"
      class="ms-2 sm:ms-4"
      :icon="collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
      :label="foldLabel"
      :aria-label="
        t('agenda.fold.of', {
          action: foldLabel,
          number: numberText,
          title: item.title,
        })
      "
      :aria-expanded="!collapsed"
      :aria-controls="agendaChildrenId(item.id)"
      :data-agenda-fold="item.id"
      @click="ctx.toggleFold(item.id)"
    />

    <ol
      v-if="node.children.length > 0"
      v-show="!collapsed"
      :id="agendaChildrenId(item.id)"
      class="border-default ms-2 space-y-3 border-s ps-3 sm:ms-4 sm:ps-4"
    >
      <AgendaItemNode
        v-for="child in node.children"
        :key="child.item.id"
        :node="child"
      />
    </ol>
  </li>
</template>
