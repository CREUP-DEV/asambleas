<script lang="ts">
import type { InjectionKey, Ref } from "vue";
import type { AgendaItemDto, DocumentSummaryDto } from "~~/shared/types/api";
import type { AgendaMove, AgendaTreeNode } from "~/utils/agendaTree";

/** What the agenda page shares with every (recursive) item node. */
export interface AgendaTreeContext {
  /** The actor manages the assembly (edit, move, delete items). */
  manage: Readonly<Ref<boolean>>;
  /** Final agenda: root items cannot be created, moved or deleted. */
  rootsLocked: Readonly<Ref<boolean>>;
  /** The actor creates documents as a manager anywhere. */
  canCreateDocument: Readonly<Ref<boolean>>;
  /** The actor may present a document as a member right now. */
  canSubmitDocument: Readonly<Ref<boolean>>;
  /** Why a member cannot present documents now (deadline, closed), if so. */
  submitBlockedReason: Readonly<Ref<string | null>>;
  /** Item with a request in flight. */
  busyId: Readonly<Ref<string | null>>;
  documentsFor: (itemId: string) => DocumentSummaryDto[];
  documentPath: (document: DocumentSummaryDto) => string;
  canMove: (itemId: string, move: AgendaMove) => boolean;
  canDelete: (itemId: string) => boolean;
  move: (itemId: string, move: AgendaMove) => void;
  edit: (item: AgendaItemDto) => void;
  addChild: (node: AgendaTreeNode<AgendaItemDto>) => void;
  remove: (node: AgendaTreeNode<AgendaItemDto>) => void;
  toggleSubmissions: (item: AgendaItemDto, value: boolean) => void;
  newDocument: (
    node: AgendaTreeNode<AgendaItemDto>,
    mode: "manager" | "member",
  ) => void;
}

export const AGENDA_TREE_CONTEXT: InjectionKey<AgendaTreeContext> =
  Symbol("agenda-tree");

/** DOM id of an item's heading (focus target and anchor). */
export function agendaItemAnchor(id: string): string {
  return `agenda-item-${id}`;
}
</script>

<script setup lang="ts">
/**
 * One agenda item with its documents, its manager controls (move, edit,
 * submissions switch, actions menu) and its sub-items, rendered recursively
 * as nested ordered lists.
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
const isRoot = computed(() => props.node.depth === 0);
const locked = computed(() => isRoot.value && ctx.rootsLocked.value);
const busy = computed(() => ctx.busyId.value === item.value.id);
const documents = computed(() => ctx.documentsFor(item.value.id));
const headingLevel = computed(() => (props.node.depth === 0 ? "h3" : "h4"));

const MOVES: { move: AgendaMove; icon: string }[] = [
  { move: "up", icon: "i-lucide-arrow-up" },
  { move: "down", icon: "i-lucide-arrow-down" },
  { move: "outdent", icon: "i-lucide-indent-decrease" },
  { move: "indent", icon: "i-lucide-indent-increase" },
];

const moveLabel = (move: AgendaMove) =>
  t(`agenda.move.${move}`, {
    number: props.node.number,
    title: item.value.title,
  });

const showMemberSubmit = computed(
  () =>
    item.value.acceptsSubmissions &&
    !ctx.canCreateDocument.value &&
    ctx.canSubmitDocument.value,
);
const showSubmitBlocked = computed(
  () =>
    item.value.acceptsSubmissions &&
    !ctx.canCreateDocument.value &&
    !ctx.canSubmitDocument.value &&
    Boolean(ctx.submitBlockedReason.value),
);

const menuItems = computed(() => {
  const groups = [
    [
      {
        label: t("agenda.actions.edit"),
        icon: "i-lucide-pencil",
        onSelect: () => ctx.edit(item.value),
      },
      {
        label: t("agenda.actions.addSubItem"),
        icon: "i-lucide-list-plus",
        onSelect: () => ctx.addChild(props.node),
      },
      ...(ctx.canCreateDocument.value
        ? [
            {
              label: t("agenda.actions.newDocument"),
              icon: "i-lucide-file-plus",
              onSelect: () => ctx.newDocument(props.node, "manager"),
            },
          ]
        : []),
    ],
    [
      {
        label: t("agenda.actions.delete"),
        icon: "i-lucide-trash-2",
        color: "error" as const,
        disabled: !ctx.canDelete(item.value.id),
        onSelect: () => ctx.remove(props.node),
      },
    ],
  ];
  return groups;
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
          <span class="text-primary me-2 tabular-nums">{{ node.number }}.</span>
          <span class="break-words">{{ item.title }}</span>
        </component>

        <div class="flex flex-wrap items-center gap-1.5">
          <UTooltip v-if="locked" :text="t('agenda.lockedRoot')">
            <UBadge
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-lock"
            >
              <span class="sr-only">{{ t("agenda.lockedRoot") }}</span>
            </UBadge>
          </UTooltip>
          <UBadge
            v-if="item.acceptsSubmissions && !ctx.manage.value"
            color="secondary"
            variant="soft"
            size="sm"
            icon="i-lucide-inbox"
            :label="t('agenda.acceptsSubmissionsBadge')"
          />
        </div>
      </div>

      <p
        v-if="item.description"
        class="text-muted mt-1 text-sm whitespace-pre-line"
      >
        {{ item.description }}
      </p>

      <!-- Manager controls -->
      <div
        v-if="ctx.manage.value"
        class="border-default mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3"
      >
        <UFieldGroup
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

        <USwitch
          :model-value="item.acceptsSubmissions"
          :loading="busy"
          size="sm"
          :label="t('agenda.acceptsSubmissions')"
          @update:model-value="ctx.toggleSubmissions(item, Boolean($event))"
        />

        <div class="ms-auto flex items-center gap-1">
          <UButton
            v-if="ctx.canCreateDocument.value"
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-file-plus"
            :label="t('agenda.actions.newDocument')"
            class="hidden sm:inline-flex"
            @click="ctx.newDocument(node, 'manager')"
          />
          <UDropdownMenu :items="menuItems" :content="{ align: 'end' }">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-ellipsis-vertical"
              :aria-label="
                t('agenda.actions.menu', {
                  number: node.number,
                  title: item.title,
                })
              "
            />
          </UDropdownMenu>
        </div>
      </div>

      <!-- Document managers without assembly management, or members -->
      <div
        v-else-if="
          ctx.canCreateDocument.value || showMemberSubmit || showSubmitBlocked
        "
        class="mt-3"
      >
        <UButton
          v-if="ctx.canCreateDocument.value"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-file-plus"
          :label="t('agenda.actions.newDocument')"
          @click="ctx.newDocument(node, 'manager')"
        />
        <UButton
          v-else-if="showMemberSubmit"
          size="sm"
          icon="i-lucide-file-up"
          :label="t('agenda.actions.submitDocument')"
          @click="ctx.newDocument(node, 'member')"
        />
        <p
          v-else-if="showSubmitBlocked"
          class="text-muted flex items-center gap-1.5 text-sm"
        >
          <UIcon name="i-lucide-lock" class="size-4" aria-hidden="true" />
          {{ ctx.submitBlockedReason.value }}
        </p>
      </div>

      <!-- Documents -->
      <ul
        v-if="documents.length > 0"
        class="mt-3 space-y-2"
        :aria-label="
          t('agenda.documentsOf', { number: node.number, title: item.title })
        "
      >
        <li v-for="document in documents" :key="document.id">
          <AgendaDocumentRow
            :document="document"
            :to="ctx.documentPath(document)"
          />
        </li>
      </ul>
    </div>

    <ol
      v-if="node.children.length > 0"
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
