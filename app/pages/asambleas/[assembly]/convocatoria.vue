<script setup lang="ts">
import type { AssemblyDto, DocumentSummaryDto } from "~~/shared/types/api";
import { CONVOCATION_INTRO_MAX_LENGTH } from "~~/shared/utils/schemas/assembly";

/**
 * Print-ready convocatoria generated from the assembly, its agenda and its
 * calendar. It leaves the app shell (`layout: false`) and the hub renders
 * it without its chrome (`meta.print`); the toolbar is hidden when printing. Managers edit the introduction inline.
 */
definePageMeta({ print: true, layout: false });

const { t, locale } = useI18n();
const toast = useToast();
const api = useApi();
const current = useCurrentAssembly();
const { assembly, sectionPath } = current;

const {
  data: agenda,
  pending: agendaPending,
  error: agendaError,
  refresh: refreshAgenda,
} = await useAssemblyAgenda();

const typeName = computed(() =>
  assembly.value ? t(`assembly.types.${assembly.value.type}`) : "",
);
/** "80.ª Asamblea General Ordinaria" / "80th Ordinary General Assembly". */
const fullName = computed(() =>
  assembly.value
    ? `${assemblyOrdinal(assembly.value.number, locale.value)} ${typeName.value}`
    : "",
);
const heading = computed(() =>
  t("convocation.heading", { assembly: fullName.value }),
);

useHead({ title: () => heading.value });

const dateRange = computed(() =>
  assembly.value
    ? formatAssemblyDateRange(
        assembly.value.startDate,
        assembly.value.endDate,
        locale.value,
      )
    : "",
);

// Agenda ------------------------------------------------------------------------

// The call is the same for everyone: an item that is not in the agenda for
// everyone yet (no number) is left out of it.
const rows = computed(() =>
  flattenAgendaTree(buildAgendaTree(agenda.value?.items ?? [])).filter(
    (row) => row.number !== null,
  ),
);

const PUBLIC_DOCUMENT_STATUSES = new Set(["published", "postponed"]);
const documentsByItem = computed(() => {
  const map = new Map<string, DocumentSummaryDto[]>();
  for (const document of agenda.value?.documents ?? []) {
    if (!PUBLIC_DOCUMENT_STATUSES.has(document.status)) continue;
    const list = map.get(document.agendaItemId);
    if (list) list.push(document);
    else map.set(document.agendaItemId, [document]);
  }
  return map;
});

// Annex: deadlines and procedures -----------------------------------------------

const milestones = computed(() =>
  [...(assembly.value?.milestones ?? [])].sort((a, b) =>
    a.at.localeCompare(b.at),
  ),
);

const convocationDate = computed(
  () =>
    assembly.value?.milestones.find(
      (milestone) => milestone.key === "convocation",
    )?.at ?? null,
);

// Introduction ------------------------------------------------------------------

const defaultIntro = computed(() =>
  assembly.value
    ? t("convocation.defaultIntro", {
        assembly: fullName.value,
        location: assembly.value.location,
        dates: dateRange.value,
      })
    : "",
);
const intro = computed(
  () => assembly.value?.convocationIntro?.trim() || defaultIntro.value,
);
const usingDefaultIntro = computed(() => !assembly.value?.convocationIntro);

const editing = ref(false);
const draft = ref("");
const saving = ref(false);
const announcement = ref("");
const introField = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>(
  "introField",
);

function startEditing() {
  draft.value = assembly.value?.convocationIntro ?? defaultIntro.value;
  editing.value = true;
  void nextTick(() => introField.value?.textareaRef?.focus());
}

function cancelEditing() {
  editing.value = false;
}

async function saveIntro(value: string | null) {
  const target = assembly.value;
  if (!target) return;
  saving.value = true;
  try {
    const updated = await api.send<AssemblyDto>(current.apiBase.value, {
      method: "PUT",
      body: {
        convocationIntro: value?.trim() ? value.trim() : null,
        updatedAt: target.updatedAt,
      },
    });
    current.setAssembly(updated);
    editing.value = false;
    announcement.value = t("convocation.introSaved");
    toast.add({
      title: t("convocation.introSaved"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "convocation.introError");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    saving.value = false;
  }
}

function printPage() {
  if (import.meta.client) window.print();
}
</script>

<template>
  <main
    v-if="assembly"
    id="main-content"
    class="bg-muted/40 min-h-svh print:min-h-0 print:bg-transparent"
  >
    <!-- Toolbar -->
    <div
      class="no-print border-default bg-default/95 sticky top-0 z-10 border-b backdrop-blur"
    >
      <UContainer
        class="flex flex-wrap items-center justify-between gap-2 py-2"
      >
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left"
          :label="t('convocation.back', { assembly: assembly.label })"
          :to="sectionPath()"
        />
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            v-if="assembly.can.manage && !editing"
            color="neutral"
            variant="outline"
            icon="i-lucide-pencil"
            :label="t('convocation.editIntro')"
            @click="startEditing"
          />
          <UButton
            icon="i-lucide-printer"
            :label="t('convocation.print')"
            @click="printPage"
          />
        </div>
      </UContainer>
    </div>

    <div class="px-4 py-6 sm:py-10 print:p-0">
      <UAlert
        v-if="!assembly.agendaFinalizedAt || assembly.status === 'draft'"
        class="no-print mx-auto mb-4 max-w-3xl"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="
          assembly.status === 'draft'
            ? t('convocation.draftWarning')
            : t('convocation.provisionalWarning')
        "
      />

      <article
        class="bg-default text-default ring-default mx-auto max-w-3xl rounded-lg p-6 shadow-sm ring-1 sm:p-12 print:max-w-none print:rounded-none print:p-0 print:shadow-none print:ring-0"
        :aria-labelledby="'convocation-title'"
      >
        <header
          class="convocation-header border-primary mb-8 flex flex-wrap items-end justify-between gap-4 border-b-2 pb-4"
        >
          <div>
            <img
              src="/creup-site-header-logo-light.svg"
              alt="CREUP"
              class="h-10 w-auto sm:h-12 dark:hidden print:block"
            />
            <img
              src="/creup-site-header-logo-dark.svg"
              alt="CREUP"
              class="hidden h-10 w-auto sm:h-12 dark:block print:hidden"
            />
          </div>
          <p class="text-muted text-sm">{{ t("convocation.issuer") }}</p>
        </header>

        <h1
          id="convocation-title"
          class="text-highlighted text-2xl leading-tight font-bold sm:text-3xl"
        >
          {{ heading }}
        </h1>
        <p
          v-if="!assembly.agendaFinalizedAt"
          class="text-warning mt-1 text-sm font-medium"
        >
          {{ t("convocation.provisionalAgenda") }}
        </p>

        <dl
          class="border-default my-6 grid gap-x-6 gap-y-2 border-y py-4 text-sm sm:grid-cols-[auto_1fr]"
        >
          <dt class="text-muted font-medium">{{ t("convocation.place") }}</dt>
          <dd class="text-highlighted">{{ assembly.location }}</dd>
          <dt class="text-muted font-medium">{{ t("convocation.dates") }}</dt>
          <dd class="text-highlighted">{{ dateRange }}</dd>
          <dt class="text-muted font-medium">{{ t("convocation.start") }}</dt>
          <dd class="text-highlighted">
            {{ formatDateTime(assembly.startDate, { locale, style: "long" }) }}
          </dd>
          <dt class="text-muted font-medium">{{ t("convocation.end") }}</dt>
          <dd class="text-highlighted">
            {{ formatDateTime(assembly.endDate, { locale, style: "long" }) }}
          </dd>
        </dl>

        <!-- Introduction -->
        <section class="mb-8" :aria-label="t('convocation.introLabel')">
          <div v-if="editing" class="no-print space-y-3">
            <UFormField
              :label="t('convocation.introLabel')"
              :help="t('convocation.introHelp')"
            >
              <UTextarea
                ref="introField"
                v-model="draft"
                :rows="8"
                autoresize
                :maxrows="24"
                :maxlength="CONVOCATION_INTRO_MAX_LENGTH"
                :disabled="saving"
                class="w-full"
              />
            </UFormField>
            <div class="flex flex-wrap justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                :label="t('convocation.restoreDefault')"
                icon="i-lucide-rotate-ccw"
                :disabled="saving || usingDefaultIntro"
                @click="saveIntro(null)"
              />
              <UButton
                color="neutral"
                variant="outline"
                :label="t('common.cancel')"
                :disabled="saving"
                @click="cancelEditing"
              />
              <UButton
                icon="i-lucide-save"
                :label="t('common.save')"
                :loading="saving"
                @click="saveIntro(draft)"
              />
            </div>
          </div>
          <div v-else class="group relative">
            <p class="text-default leading-relaxed whitespace-pre-line">
              {{ intro }}
            </p>
            <p
              v-if="assembly.can.manage && usingDefaultIntro"
              class="no-print text-dimmed mt-2 text-xs"
            >
              {{ t("convocation.defaultIntroNotice") }}
            </p>
          </div>
        </section>

        <!-- Agenda -->
        <section class="mb-8" aria-labelledby="convocation-agenda">
          <h2
            id="convocation-agenda"
            class="text-highlighted mb-3 text-lg font-bold tracking-wide uppercase"
          >
            {{ t("convocation.agendaTitle") }}
          </h2>
          <div v-if="agendaPending && !agenda" class="space-y-2" role="status">
            <span class="sr-only">{{ t("agenda.loading") }}</span>
            <USkeleton
              v-for="index in 5"
              :key="index"
              aria-hidden="true"
              class="h-5 w-full"
            />
          </div>
          <UAlert
            v-else-if="agendaError && !agenda"
            class="no-print"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('agenda.loadError')"
            :actions="[
              {
                label: t('agenda.retry'),
                color: 'neutral',
                variant: 'outline',
                onClick: () => {
                  void refreshAgenda();
                },
              },
            ]"
          />
          <p v-else-if="rows.length === 0" class="text-muted italic">
            {{ t("convocation.agendaEmpty") }}
          </p>
          <ol v-else class="space-y-2">
            <li
              v-for="row in rows"
              :key="row.item.id"
              class="flex gap-2 break-inside-avoid"
              :style="{ paddingInlineStart: `${row.depth * 1.5}rem` }"
            >
              <span
                class="text-highlighted shrink-0 font-semibold tabular-nums"
                aria-hidden="true"
                >{{ row.number }}.</span
              >
              <div class="min-w-0">
                <p
                  :class="
                    row.depth === 0 ? 'text-highlighted font-semibold' : ''
                  "
                >
                  <span class="sr-only">{{ row.number }}. </span
                  >{{ row.item.title }}
                </p>
                <p
                  v-if="row.item.description"
                  class="text-muted text-sm whitespace-pre-line"
                >
                  {{ row.item.description }}
                </p>
                <ul
                  v-if="(documentsByItem.get(row.item.id) ?? []).length > 0"
                  class="text-muted mt-1 space-y-0.5 text-sm"
                >
                  <li
                    v-for="document in documentsByItem.get(row.item.id)"
                    :key="document.id"
                    class="flex gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-file-text"
                      class="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {{ document.title
                      }}<template v-if="document.reference">
                        ({{ document.reference }})</template
                      >
                    </span>
                  </li>
                </ul>
              </div>
            </li>
          </ol>
        </section>

        <!-- Signature -->
        <section class="mb-10 break-inside-avoid">
          <p v-if="convocationDate" class="text-default">
            {{
              t("convocation.signedAt", {
                location: assembly.location,
                date: formatDate(convocationDate, { locale }),
              })
            }}
          </p>
          <p class="text-highlighted mt-6 font-semibold">
            {{ t("convocation.signature") }}
          </p>
        </section>

        <!-- Annex -->
        <section
          class="border-default border-t pt-6 print:break-before-page"
          aria-labelledby="convocation-annex"
        >
          <h2
            id="convocation-annex"
            class="text-highlighted mb-1 text-lg font-bold tracking-wide uppercase"
          >
            {{ t("convocation.annexTitle") }}
          </h2>
          <p class="text-muted mb-4 text-sm">
            {{ t("convocation.annexIntro") }}
          </p>
          <p v-if="milestones.length === 0" class="text-muted italic">
            {{ t("convocation.annexEmpty") }}
          </p>
          <ol v-else class="space-y-4">
            <li
              v-for="milestone in milestones"
              :key="milestone.key"
              class="border-primary/60 break-inside-avoid border-s-2 ps-4"
            >
              <p class="text-highlighted font-semibold">
                {{ t(`calendar.milestones.${milestone.key}`) }}
              </p>
              <p class="text-default text-sm font-medium tabular-nums">
                <time :datetime="milestone.at">{{
                  formatDateTime(milestone.at, { locale, style: "long" })
                }}</time>
              </p>
              <p class="text-muted mt-1 text-sm">
                {{ t(`convocation.procedures.${milestone.key}`) }}
              </p>
              <p
                v-if="milestone.note"
                class="text-muted mt-1 text-sm whitespace-pre-line italic"
              >
                {{ milestone.note }}
              </p>
            </li>
          </ol>
          <p class="text-dimmed mt-6 text-xs">
            {{ t("convocation.timeZoneNote") }}
          </p>
        </section>
      </article>
    </div>

    <p class="sr-only" aria-live="polite" role="status">{{ announcement }}</p>
  </main>
</template>
