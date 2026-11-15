<script setup lang="ts">
import {
  SEATING_MANUAL_GROUP_KINDS,
  type SeatingManualGroupKind,
} from "~~/shared/constants/domain";
import type {
  SeatingGroupDto,
  SeatingPersonDto,
  SeatingPersonUpdateBody,
} from "~~/shared/types/api";
import { SEATING_LIMITS } from "~~/shared/utils/schemas/seating";
import type { SeatingPersonDraft } from "./-placing";

/**
 * «Añadir persona» and «Editar» of the tray (docs/seating-plan.md, section
 * 7). Adding: to the Mesa, to any group or to a new group made by hand
 * («Prensa»), with a name, surnames, a cargo and whether they need a seat.
 * Editing: the name of someone added by hand (a «Plaza sin nombre» given a
 * name becomes a person), and anyone's cargo; an Intranet registration's
 * name changes in the Intranet. A Mesa person may be linked to the viewer's
 * own platform account («Es mi cuenta»); no list of other accounts is read
 * here.
 */

const props = defineProps<{
  /** Null: adding someone. */
  person: SeatingPersonDto | null;
  /** Every group, in seating order (the Mesa first). */
  groups: readonly SeatingGroupDto[];
  /** The group the dialog opens on when adding. */
  groupId: string | null;
  meId: string | null;
  saving: boolean;
}>();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{
  add: [draft: SeatingPersonDraft];
  edit: [changes: Omit<SeatingPersonUpdateBody, "updatedAt">];
}>();

const { t } = useI18n();
const { personLabel } = useSeatingWords();

const NEW_GROUP = "__new";

const groupChoice = ref<string>(NEW_GROUP);
const acronym = ref("");
const groupName = ref("");
const kind = ref<SeatingManualGroupKind>("other");
const firstName = ref("");
const surname = ref("");
const label = ref("");
const needsSeat = ref(true);
const linkMe = ref(false);
const tried = ref(false);

const editing = computed(() => props.person !== null);
const intranet = computed(() => props.person?.source === "intranet");
const mesaGroupId = computed(
  () => props.groups.find((group) => group.kind === "mesa")?.id ?? null,
);
const inMesa = computed(() =>
  editing.value
    ? props.person?.groupId === mesaGroupId.value
    : groupChoice.value === mesaGroupId.value,
);
const linkedElsewhere = computed(
  () => Boolean(props.person?.userId) && props.person?.userId !== props.meId,
);

watch(open, (value) => {
  if (!value) return;
  tried.value = false;
  const person = props.person;
  groupChoice.value =
    props.groupId ?? mesaGroupId.value ?? props.groups[0]?.id ?? NEW_GROUP;
  acronym.value = "";
  groupName.value = "";
  kind.value = "other";
  firstName.value = person?.firstName ?? "";
  surname.value = person?.surname ?? "";
  label.value = person?.label ?? "";
  needsSeat.value = person?.needsSeat ?? true;
  linkMe.value = Boolean(person?.userId && person.userId === props.meId);
});

const groupItems = computed(() => [
  ...props.groups
    .filter((group) => !group.goneAt)
    .map((group) => ({
      value: group.id,
      label: group.acronym,
      description: group.name === group.acronym ? undefined : group.name,
    })),
  { value: NEW_GROUP, label: t("seating.people.newGroup") },
]);
const kindItems = computed(() =>
  SEATING_MANUAL_GROUP_KINDS.map((value) => ({
    value,
    label: t(`seating.groups.kinds.${value}`),
  })),
);

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

const newGroup = computed(
  () => !editing.value && groupChoice.value === NEW_GROUP,
);
/** A placeholder may stay without a name; anyone else needs one. */
const nameRequired = computed(
  () => !editing.value || props.person?.source === "manual",
);
const errors = computed(() => ({
  acronym: newGroup.value && !clean(acronym.value),
  groupName: newGroup.value && !clean(groupName.value),
  firstName:
    !intranet.value &&
    ((nameRequired.value && !clean(firstName.value)) ||
      (!clean(firstName.value) && Boolean(clean(surname.value)))),
}));
const valid = computed(() => !Object.values(errors.value).some(Boolean));

function submit(): void {
  tried.value = true;
  if (!valid.value || props.saving) return;
  const nextLabel = clean(label.value) || null;
  if (!props.person) {
    emit("add", {
      group: newGroup.value
        ? {
            acronym: clean(acronym.value),
            name: clean(groupName.value),
            kind: kind.value,
          }
        : { id: groupChoice.value },
      firstName: clean(firstName.value),
      surname: clean(surname.value) || null,
      label: nextLabel,
      needsSeat: needsSeat.value,
      linkMe: inMesa.value && linkMe.value,
    });
    return;
  }
  const person = props.person;
  const changes: Omit<SeatingPersonUpdateBody, "updatedAt"> = {};
  if (nextLabel !== person.label) changes.label = nextLabel;
  if (!intranet.value) {
    const first = clean(firstName.value);
    const last = clean(surname.value) || null;
    if (first && first !== person.firstName) changes.firstName = first;
    if (last !== person.surname && (first || person.firstName)) {
      changes.surname = last;
    }
    if (inMesa.value && props.meId) {
      const mine = person.userId === props.meId;
      if (linkMe.value && !mine) changes.userId = props.meId;
      if (!linkMe.value && mine) changes.userId = null;
    }
  }
  emit("edit", changes);
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      person
        ? t('seating.people.editTitle', { name: personLabel(person) })
        : t('seating.people.addTitle')
    "
    :dismissible="!saving"
  >
    <template #body>
      <form
        id="seating-person-form"
        class="space-y-4"
        novalidate
        @submit.prevent="submit"
      >
        <template v-if="!person">
          <UFormField :label="t('seating.people.group')" required>
            <USelectMenu
              v-model="groupChoice"
              :items="groupItems"
              value-key="value"
              :search-input="{ placeholder: t('seating.people.groupSearch') }"
              class="w-full"
            />
          </UFormField>
          <div
            v-if="newGroup"
            class="border-default grid gap-3 rounded-md border p-3 sm:grid-cols-2"
          >
            <UFormField
              :label="t('seating.groups.acronym')"
              :hint="t('seating.groups.acronymHint')"
              :error="
                tried && errors.acronym
                  ? t('seating.people.required')
                  : undefined
              "
              required
            >
              <UInput
                v-model="acronym"
                :maxlength="SEATING_LIMITS.acronym"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('seating.groups.kind')">
              <USelect
                v-model="kind"
                :items="kindItems"
                value-key="value"
                class="w-full"
              />
            </UFormField>
            <UFormField
              class="sm:col-span-2"
              :label="t('seating.groups.name')"
              :error="
                tried && errors.groupName
                  ? t('seating.people.required')
                  : undefined
              "
              required
            >
              <UInput
                v-model="groupName"
                :maxlength="SEATING_LIMITS.groupName"
                class="w-full"
              />
            </UFormField>
          </div>
        </template>

        <p v-if="intranet" class="text-muted text-sm">
          {{ t("seating.people.intranetHint") }}
        </p>
        <div v-else class="grid gap-3 sm:grid-cols-2">
          <UFormField
            :label="t('seating.people.firstName')"
            :error="
              tried && errors.firstName
                ? t('seating.people.required')
                : undefined
            "
            :required="nameRequired"
          >
            <UInput
              v-model="firstName"
              :maxlength="SEATING_LIMITS.firstName"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('seating.people.surname')">
            <UInput
              v-model="surname"
              :maxlength="SEATING_LIMITS.surname"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          :label="t('seating.people.label')"
          :hint="t('seating.people.labelHint')"
        >
          <UInput
            v-model="label"
            :maxlength="SEATING_LIMITS.label"
            class="w-full"
          />
        </UFormField>

        <UCheckbox
          v-if="!person"
          v-model="needsSeat"
          :label="t('seating.people.needsSeat')"
        />

        <div v-if="inMesa && !intranet && meId" class="space-y-1">
          <UCheckbox
            v-model="linkMe"
            :label="t('seating.people.linkMe')"
            :description="t('seating.people.linkMeHint')"
          />
          <p v-if="linkedElsewhere" class="text-muted text-sm">
            {{ t("seating.people.linkedToOther") }}
          </p>
        </div>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          :disabled="saving"
          @click="open = false"
        />
        <UButton
          type="submit"
          form="seating-person-form"
          :icon="person ? 'i-lucide-save' : 'i-lucide-user-plus'"
          :label="person ? t('common.save') : t('seating.people.add')"
          :loading="saving"
        />
      </div>
    </template>
  </UModal>
</template>
