<script setup lang="ts">
import type { MemberRef } from "~~/shared/types/api";
import {
  choicePresenterIds,
  handedOverMainPresenter,
  needsMainPresenter,
  stablePresenterOrder,
} from "~/composables/document/documentPresenters";

/**
 * Presenting a document with other members, inside a form:
 *
 * - "¿Lo presentáis varios miembros?", folded unless there are co-presenters
 *   already, holds a member search to add them, saying that they prepare
 *   the text too but cannot change who answers the amendments (only that
 *   member or the Secretaría can; the server refuses it with `main_only`);
 * - with several presenters, the required choice of who answers the
 *   amendments (the main presenter), with what that means in one line.
 *
 * The lead (the member picked under "Quién lo presenta", or the presenter's
 * own member) is fixed here: it is never offered as a co-presenter and is
 * always among the choices. So are `fixedIds` (a co-presenter cannot drop
 * the main presenter), and with `mainLocked` the choice of who answers is
 * shown but cannot change: only that member or the Secretaría hands it
 * over. A presenter who picks another member to answer is told so before
 * saving, since afterwards they cannot take it back themselves. The parent
 * loads the members (`load` fires in the browser when the section opens),
 * may react to `update:mainId` (managers make the chosen one the lead) and
 * validates `mainName` with `mainPresenterMissing`. The choices keep their
 * order while the lead changes, so the radio just picked never moves.
 */
const props = withDefaults(
  defineProps<{
    /** "presenter" talks to the presenting member; "manager" about them. */
    voice: "presenter" | "manager";
    leadId: string | null;
    /** Members that can be added (active ones). */
    members: MemberRef[];
    /** Members to name even if not listed (current presenters, inactive). */
    known?: MemberRef[];
    loading?: boolean;
    /** The user's own member, marked as theirs. */
    ownMemberId?: string | null;
    /** Co-presenters this user cannot remove (kept, not offered). */
    fixedIds?: string[];
    /** Who answers the amendments is shown but cannot be changed here. */
    mainLocked?: boolean;
    disabled?: boolean;
    /** Form field names, for validation errors. */
    name?: string;
    mainName?: string;
  }>(),
  {
    known: () => [],
    loading: false,
    ownMemberId: null,
    fixedIds: () => [],
    mainLocked: false,
    disabled: false,
    name: "coProponents",
    mainName: "mainPresenter",
  },
);

const coIds = defineModel<string[]>("coIds", { required: true });
const mainId = defineModel<string | null>("mainId", { required: true });

const emit = defineEmits<{ load: [] }>();

const { t } = useI18n();

/** The co-presenters this user may add or remove. */
const editableCoIds = computed<string[]>({
  get: () => coIds.value.filter((id) => !props.fixedIds.includes(id)),
  set: (ids) => {
    coIds.value = [
      ...coIds.value.filter((id) => props.fixedIds.includes(id)),
      ...ids.filter((id) => !props.fixedIds.includes(id)),
    ];
  },
});

const open = ref(editableCoIds.value.length > 0);
// Members load in the browser only, when the section is open.
watch(open, (isOpen) => {
  if (isOpen) emit("load");
});
onMounted(() => {
  if (open.value) emit("load");
});
// Co-presenters set from outside (a reset, a reload) unfold the section.
watch(
  () => editableCoIds.value.length,
  (count) => {
    if (count > 0) open.value = true;
  },
);

const byId = computed(() => {
  const map = new Map<string, MemberRef>();
  for (const member of [...props.known, ...props.members]) {
    map.set(member.id, member);
  }
  return map;
});

/**
 * Everyone but the lead and the fixed ones; current co-presenters stay even
 * if inactive.
 */
const coItems = computed(() => {
  const listed = props.members.filter(
    (member) =>
      member.id !== props.leadId && !props.fixedIds.includes(member.id),
  );
  const missing = editableCoIds.value
    .filter((id) => !listed.some((member) => member.id === id))
    .map((id) => byId.value.get(id))
    .filter((member): member is MemberRef => Boolean(member));
  return [...missing, ...listed].map((member) => ({
    label: member.acronym,
    description: memberNameRepeatsAcronym(member) ? undefined : member.name,
    value: member.id,
  }));
});

const choice = computed(() => ({
  leadId: props.leadId,
  coIds: coIds.value,
  mainId: mainId.value,
}));

const showMain = computed(() => needsMainPresenter(choice.value));

/** The presenters in a stable order (see stablePresenterOrder). */
const order = ref<string[]>([]);
watch(
  () => choicePresenterIds(choice.value),
  (ids) => {
    order.value = stablePresenterOrder(order.value, ids);
  },
  { immediate: true },
);

const mainItems = computed(() =>
  order.value.map((id) => {
    const member = byId.value.get(id);
    const label = member ? memberLabel(member) : id;
    return {
      label,
      description:
        id === props.ownMemberId ? t("document.presenters.yours") : undefined,
      value: id,
    };
  }),
);

/**
 * A presenter handing answering the amendments to another member: once
 * stored only that member or the Secretaría can change it, so say it first.
 */
const handOverHelp = computed(() => {
  if (props.voice !== "presenter" || props.mainLocked) return undefined;
  const id = handedOverMainPresenter(choice.value, props.ownMemberId);
  if (!id) return undefined;
  const member = byId.value.get(id)?.acronym ?? id;
  return t("document.presenters.handOver", { member });
});

function onMainChange(value: unknown): void {
  mainId.value = typeof value === "string" ? value : null;
}
</script>

<template>
  <div class="space-y-4">
    <UCollapsible v-model:open="open">
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        class="px-0"
        :icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="t(`document.presenters.fold.${voice}`)"
        :disabled="disabled"
      />
      <template #content>
        <div class="pt-2">
          <UFormField
            :name="name"
            :label="t('document.presenters.coLabel')"
            :description="t(`document.presenters.coHelp.${voice}`)"
          >
            <USelectMenu
              v-model="editableCoIds"
              :items="coItems"
              value-key="value"
              multiple
              :filter-fields="['label', 'description']"
              :loading="loading"
              :disabled="disabled"
              :placeholder="t('document.presenters.coPlaceholder')"
              :aria-label="
                selectMenuLabel(
                  t('document.presenters.coLabel'),
                  coItems,
                  editableCoIds,
                  t('document.presenters.coPlaceholder'),
                )
              "
              :search-input="
                labelledSearch(t('document.metadata.searchMember'))
              "
              class="w-full"
            />
          </UFormField>
        </div>
      </template>
    </UCollapsible>

    <UFormField
      v-if="showMain"
      :name="mainName"
      :label="t('document.presenters.main')"
      :description="
        mainLocked
          ? `${t('document.presenters.mainHelp')} ${t('document.presenters.mainLockedHelp')}`
          : t('document.presenters.mainHelp')
      "
      :help="handOverHelp"
      required
    >
      <URadioGroup
        :model-value="mainId ?? undefined"
        :items="mainItems"
        value-key="value"
        orientation="vertical"
        :disabled="disabled || mainLocked"
        class="w-full"
        @update:model-value="onMainChange"
      />
    </UFormField>
  </div>
</template>
