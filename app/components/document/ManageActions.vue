<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { DocumentDto, DocumentUpdateBody } from "~~/shared/types/api";

/**
 * Secretaría actions on a document (`document.can.manage`) at any stage:
 * withdraw, postpone, recover a withdrawn submission and delete it
 * (`document.can.delete`). Each one asks for confirmation first. Publishing
 * (and publishing again) stays with the page's publish dialog; with
 * `publishable` a button "Publicar ahora" shows beside the menu, which only
 * emits `publish` (for a draft still in a presenter's hands, where
 * publishing is not the screen's main action). It is a button of its own:
 * nothing the Secretaría does often hides in the menu.
 *
 * Status changes PUT `{ status, updatedAt }` and emit `updated` with the
 * returned DocumentDto (store it); a conflict emits `stale` (refetch).
 * Deleting emits `deleted` once the server confirms: the parent leaves.
 *
 * The availability mirrors the server (assertStatusChange, deleteDocument):
 * - only a presented document (submitted, published, postponed) can be
 *   withdrawn: a draft is still private to its proponent, and an unwanted one
 *   is deleted instead;
 * - only published texts can be postponed;
 * - a withdrawn submission that was never published goes back to "submitted"
 *   (a text that was published is published again instead);
 * - deleting follows `can.delete` (deleteBlocker): a published text only
 *   while it has no amendments. When it cannot go, the item stays disabled
 *   with the reason, so the Secretaría knows to withdraw it instead.
 * A document with a final vote keeps its status and cannot be deleted: the
 * vote must be annulled first.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentDto;
    /** "/api/assemblies/{assembly}/documents/{document}" (slugs or ids). */
    documentApi: string;
    disabled?: boolean;
    /** Offer "Publicar ahora" (the parent opens its publish dialog). */
    publishable?: boolean;
    /** The page's own entries, first in the menu ("Ver documento"). */
    leadingItems?: DropdownMenuItem[];
  }>(),
  { disabled: false, publishable: false, leadingItems: () => [] },
);

const emit = defineEmits<{
  updated: [document: DocumentDto];
  deleted: [];
  stale: [];
  publish: [];
}>();

/** True while a request runs. */
const busy = defineModel<boolean>("busy", { default: false });

const { t } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();

type StatusAction = "withdraw" | "postpone" | "restore";
type ManageAction = StatusAction | "delete";

const STATUS_TARGETS: Record<
  StatusAction,
  NonNullable<DocumentUpdateBody["status"]>
> = {
  withdraw: "withdrawn",
  postpone: "postponed",
  restore: "submitted",
};

const ICONS: Record<ManageAction, string> = {
  withdraw: "i-lucide-archive-x",
  postpone: "i-lucide-calendar-clock",
  restore: "i-lucide-archive-restore",
  delete: "i-lucide-trash-2",
};

const CONFIRM_COLORS = {
  withdraw: "error",
  postpone: "warning",
  restore: "primary",
  delete: "error",
} as const satisfies Record<ManageAction, string>;

/** The text was frozen at some point (same rule as the server). */
const everPublished = computed(
  () =>
    props.document.publishedAt !== null ||
    props.document.baseVersion !== null ||
    props.document.status === "published",
);

/** A final vote decided the document; annul it before changing the status. */
const decided = computed(
  () => props.document.finalVote !== null || props.document.consolidated,
);

/** Statuses a document can be withdrawn from: it was presented. */
const WITHDRAWABLE = new Set<DocumentDto["status"]>([
  "submitted",
  "published",
  "postponed",
]);

const available = computed<ManageAction[]>(() => {
  const current = props.document;
  if (!current.can.manage) return [];
  const list: ManageAction[] = [];
  if (!decided.value) {
    if (current.publishedAt !== null && current.status !== "postponed")
      list.push("postpone");
    if (WITHDRAWABLE.has(current.status)) list.push("withdraw");
  }
  if (
    current.status === "withdrawn" &&
    !everPublished.value &&
    current.submittedAt !== null
  )
    list.push("restore");
  if (current.can.delete) list.push("delete");
  return list;
});

/**
 * Why "Eliminar" is off. With can.manage the server refuses only for a final
 * vote or, on a published text, for its amendments (deleteBlocker).
 */
const deleteBlockedReason = computed<string | null>(() => {
  const current = props.document;
  if (!current.can.manage || current.can.delete) return null;
  return decided.value
    ? t("document.manage.delete.blockedVote")
    : t("document.manage.delete.blockedAmendments");
});

const pendingAction = ref<ManageAction | null>(null);
const confirmOpen = ref(false);
const statusText = ref("");

function ask(action: ManageAction): void {
  pendingAction.value = action;
  confirmOpen.value = true;
}

const items = computed<DropdownMenuItem[][]>(() => {
  const statusItems: DropdownMenuItem[] = available.value
    .filter((action): action is StatusAction => action !== "delete")
    .map((action) => ({
      label: t(`document.manage.${action}.label`),
      icon: ICONS[action],
      onSelect: () => ask(action),
    }));
  const dangerItems: DropdownMenuItem[] = available.value.includes("delete")
    ? [
        {
          label: t("document.delete"),
          icon: ICONS.delete,
          color: "error",
          onSelect: () => ask("delete"),
        },
      ]
    : deleteBlockedReason.value
      ? [
          {
            label: t("document.delete"),
            description: deleteBlockedReason.value,
            icon: ICONS.delete,
            disabled: true,
          },
        ]
      : [];
  return [props.leadingItems, statusItems, dangerItems].filter(
    (group) => group.length > 0,
  );
});

/**
 * A published text says what goes with it; while it is still public, the
 * dialog also points to withdrawing, which keeps everything.
 */
const deleteDescription = computed(() => {
  const title = props.document.title;
  if (!everPublished.value) {
    return t("document.manage.delete.description", { title });
  }
  const text = t("document.manage.delete.descriptionPublished", { title });
  return WITHDRAWABLE.has(props.document.status)
    ? `${text} ${t("document.manage.delete.withdrawHint")}`
    : text;
});

const copy = computed(() => {
  const action = pendingAction.value ?? "withdraw";
  if (action === "delete") {
    return {
      title: t("document.deleteConfirm"),
      description: deleteDescription.value,
      confirm: t("document.delete"),
      icon: ICONS.delete,
      color: CONFIRM_COLORS.delete,
    };
  }
  const description =
    action === "withdraw" && props.document.publishedAt !== null
      ? t("document.manage.withdraw.descriptionPublished")
      : t(`document.manage.${action}.description`);
  return {
    title: t(`document.manage.${action}.title`),
    description,
    confirm: t(`document.manage.${action}.confirm`),
    icon: ICONS[action],
    color: CONFIRM_COLORS[action],
  };
});

async function confirm(): Promise<void> {
  const action = pendingAction.value;
  if (!action || busy.value) return;
  busy.value = true;
  statusText.value = t("document.manage.working");
  try {
    if (action === "delete") {
      await send(props.documentApi, { method: "DELETE" });
      confirmOpen.value = false;
      statusText.value = t("document.deleted");
      toast.add({
        title: t("document.deleted"),
        color: "success",
        icon: "i-lucide-trash-2",
      });
      emit("deleted");
      return;
    }
    const body: DocumentUpdateBody = {
      status: STATUS_TARGETS[action],
      updatedAt: props.document.updatedAt,
    };
    const updated = await send<DocumentDto>(props.documentApi, {
      method: "PUT",
      body,
    });
    confirmOpen.value = false;
    statusText.value = t(`document.manage.${action}.success`);
    emit("updated", updated);
    toast.add({
      title: t(`document.manage.${action}.success`),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    statusText.value = "";
    notifyError(
      error,
      action === "delete"
        ? "document.manage.deleteError"
        : "document.manage.statusError",
    );
    if (isConflict(error)) {
      confirmOpen.value = false;
      emit("stale");
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UButton
    v-if="publishable"
    color="neutral"
    variant="outline"
    icon="i-lucide-megaphone"
    :label="t('document.manage.publishNow')"
    :disabled="disabled || busy"
    @click="emit('publish')"
  />
  <UDropdownMenu
    v-if="items.length > 0"
    :items="items"
    :content="{ align: 'end' }"
  >
    <UButton
      color="neutral"
      variant="outline"
      icon="i-lucide-ellipsis-vertical"
      :label="t('document.manage.menu')"
      :loading="busy"
      :disabled="disabled || busy"
    />
  </UDropdownMenu>

  <UModal
    v-model:open="confirmOpen"
    :title="copy.title"
    :description="copy.description"
    :dismissible="!busy"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #footer="{ close }">
      <UButton
        color="neutral"
        variant="ghost"
        :label="t('common.cancel')"
        :disabled="busy"
        @click="close"
      />
      <UButton
        :color="copy.color"
        :icon="copy.icon"
        :label="copy.confirm"
        :loading="busy"
        :disabled="busy"
        @click="confirm"
      />
    </template>
  </UModal>

  <p class="sr-only" role="status" aria-live="polite">{{ statusText }}</p>
</template>
