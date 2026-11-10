<script setup lang="ts">
import type {
  AmendmentAuthorsBody,
  AmendmentDto,
  MemberDto,
} from "~~/shared/types/api";
import { authorsChange } from "~~/shared/utils/amendmentAuthors";
import {
  amendmentAuthorsInOrder,
  composerMainAuthor,
} from "~/composables/amendment/workspace";

/**
 * The Secretaría corrects who presents a presented, undecided amendment or
 * transactional (POST .../authors), in case it was presented wrong: one
 * line saying who presents it now and one button that opens the authors and
 * the main author to change. The parent shows it only to those who review
 * amendments, while the authors can be changed
 * (canChangeAmendmentAuthors). They see the executive areas, so the list
 * is the plain one. The change is recorded in the history and the authors
 * read it in their news.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
}>();

const emit = defineEmits<{
  updated: [amendment: AmendmentDto];
  conflict: [];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();

const open = ref(false);
const busy = ref(false);
const attempted = ref(false);

const currentNames = computed(() => {
  const { main, others } = amendmentAuthorsInOrder(props.amendment);
  return [...(main ? [main] : []), ...others]
    .map((author) => author.acronym)
    .join(", ");
});

const {
  data: members,
  status: membersStatus,
  execute: loadMembers,
} = useLazyFetch<MemberDto[]>("/api/members", {
  key: "amendment-authors-change-members",
  server: false,
  immediate: false,
  default: () => [],
});

const authorIds = ref<string[]>([]);
const mainAuthorId = ref<string | undefined>(undefined);

function start(): void {
  authorIds.value = props.amendment.authors.map((author) => author.id);
  mainAuthorId.value = props.amendment.mainAuthorId ?? undefined;
  attempted.value = false;
  open.value = true;
  if (membersStatus.value === "idle") void loadMembers();
}

/** Active members, plus the ones already presenting it. Never the generic "CEA". */
const memberItems = computed(() => {
  const current = new Set(props.amendment.authors.map((author) => author.id));
  const listed = addableMembers(members.value ?? []).filter(
    (item) => item.active || current.has(item.id),
  );
  const known = new Set(listed.map((item) => item.id));
  return [
    ...addableMembers(props.amendment.authors).filter(
      (author) => !known.has(author.id),
    ),
    ...listed,
  ].map((item) => ({ label: memberLabel(item), value: item.id }));
});
const labelOf = (id: string) =>
  memberItems.value.find((item) => item.value === id)?.label ?? id;

const mainAuthor = computed(() =>
  composerMainAuthor(authorIds.value, mainAuthorId.value),
);
const mainAuthorItems = computed(() =>
  authorIds.value.map((id) => ({ label: labelOf(id), value: id })),
);
const authorsMissing = computed(() => authorIds.value.length === 0);
const change = computed(() =>
  authorsChange({
    currentIds: props.amendment.authors.map((author) => author.id),
    currentMain: props.amendment.mainAuthorId,
    nextIds: authorIds.value,
    nextMain: mainAuthor.value.value,
  }),
);
const canSave = computed(
  () =>
    !busy.value &&
    !authorsMissing.value &&
    !mainAuthor.value.missing &&
    change.value !== null,
);

async function save(): Promise<void> {
  attempted.value = true;
  const main = mainAuthor.value.value;
  if (!canSave.value || !main) return;
  busy.value = true;
  try {
    const body: AmendmentAuthorsBody = {
      authorMemberIds: authorIds.value,
      mainAuthorMemberId: main,
      updatedAt: props.amendment.updatedAt,
    };
    const updated = await api.send<AmendmentDto>(`${props.url}/authors`, {
      body,
    });
    toast.add({
      title:
        updated.code && updated.code !== props.amendment.code
          ? t("amendment.authorsChange.doneCode", { code: updated.code })
          : t("amendment.authorsChange.done"),
      color: "success",
      icon: "i-lucide-user-pen",
    });
    open.value = false;
    emit("updated", updated);
  } catch (error) {
    api.notifyError(error, "amendment.authorsChange.failed");
    if (api.isConflict(error)) {
      open.value = false;
      emit("conflict");
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    class="border-default flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 sm:p-4"
    :aria-label="t('amendment.authorsChange.label')"
  >
    <p class="text-default min-w-0 flex-1 basis-48 text-sm" aria-live="polite">
      {{ t("amendment.authorsChange.current", { members: currentNames }) }}
    </p>
    <UButton
      icon="i-lucide-user-pen"
      color="neutral"
      variant="outline"
      size="sm"
      :label="t('amendment.authorsChange.action')"
      @click="start"
    />

    <UModal
      v-model:open="open"
      :title="t('amendment.authorsChange.title')"
      :description="t('amendment.authorsChange.description')"
      :dismissible="!busy"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField
            :label="t('amendment.authorsChange.authors')"
            required
            :error="
              attempted && authorsMissing
                ? t('amendment.authorsChange.authorsRequired')
                : undefined
            "
          >
            <USelectMenu
              v-model="authorIds"
              :items="memberItems"
              value-key="value"
              multiple
              class="w-full"
              :loading="membersStatus === 'pending'"
              :placeholder="t('amendment.authorsChange.authorsPlaceholder')"
              :aria-label="
                selectMenuLabel(
                  t('amendment.authorsChange.authors'),
                  memberItems,
                  authorIds,
                  t('amendment.authorsChange.authorsPlaceholder'),
                )
              "
              :search-input="
                labelledSearch(t('amendment.composer.memberSearch'))
              "
            />
          </UFormField>
          <UFormField
            v-if="mainAuthor.required"
            :label="t('amendment.composer.mainAuthor')"
            required
            :help="t('amendment.authorsChange.mainAuthorHint')"
            :error="
              attempted && mainAuthor.missing
                ? t('amendment.composer.mainAuthorRequired')
                : undefined
            "
          >
            <!-- The visible label is the field's; the legend names the group. -->
            <URadioGroup
              v-model="mainAuthorId"
              :items="mainAuthorItems"
              :legend="t('amendment.composer.mainAuthor')"
              :ui="{ legend: 'sr-only' }"
              aria-required="true"
              size="sm"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="busy"
            @click="open = false"
          />
          <UButton
            :label="t('amendment.authorsChange.save')"
            :loading="busy"
            :disabled="change === null"
            @click="save"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
