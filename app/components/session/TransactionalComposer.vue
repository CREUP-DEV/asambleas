<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  isSessionDecidable,
  isSessionOpen,
  sessionSameBlocks,
  sessionSameIds,
  sessionTransactionalParties,
  sessionTransactionalSeed,
  type SessionTransactionalSeed,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Builds a transactional amendment in the room. The editor starts from the
 * passage its sources touch, with the sources applied in order of
 * presentation (when two collide, the first that applies wins). The diff
 * against the base updates as the Mesa types. Once created (and submitted),
 * the answer of every party is recorded in the acceptance list.
 *
 * The text typed live is never thrown away silently: closing the panel
 * (Escape, the overlay, the close button) keeps the draft, and reopening it
 * for the same amendments resumes it. Changing the sources, resetting the
 * text, cancelling, starting a transactional for other amendments or leaving
 * the page all ask before discarding what was typed.
 *
 * The console follows the document in debate, which another Mesa member can
 * move. A draft belongs to the document it was started on: while the console
 * shows another one the panel names that document instead of the form, the
 * draft is kept, and it comes back when the console returns to it. Starting
 * a transactional on the new document asks first, naming the old one.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.composer.open,
  set: (value: boolean) => {
    session.composer.open = value;
  },
});

const sourceIds = ref<string[]>([]);
const edited = ref<Block[]>([]);
const justification = ref("");
const authorIds = ref<string[]>([]);
/** The Mesa chose the authors by hand: a reseed keeps its choice. */
const authorsTouched = ref(false);
const createdId = ref<string | null>(null);
const seed = shallowRef<SessionTransactionalSeed | null>(null);
const editorKey = ref(0);
const editor = useTemplateRef<{ flush: () => void }>("editor");
/** Set when the Mesa discards the draft: the next opening starts afresh. */
let discarded = false;
/** The document the draft was started on: it only applies to that base. */
const draftDocumentId = ref<string | null>(null);
/** Its title, kept to name it once the console shows another document. */
const draftDocumentTitle = ref("");

/** The draft was started on a document the console no longer shows. */
const onOtherDocument = computed(
  () =>
    seed.value !== null && draftDocumentId.value !== session.documentId.value,
);

function documentTitle(id: string | null): string {
  if (!id) return "";
  if (session.document.value?.id === id) return session.document.value.title;
  for (const row of session.agendaRows.value) {
    const document = row.documents.find((candidate) => candidate.id === id);
    if (document) return document.title;
  }
  return "";
}

const eligible = computed(() =>
  session.amendments.value.filter(
    (amendment) =>
      isSessionOpen(amendment) || sourceIds.value.includes(amendment.id),
  ),
);
const sourceItems = computed(() =>
  eligible.value.map((amendment) => ({
    label: `${session.label(amendment.id)} · ${amendment.authors
      .map((author) => author.acronym)
      .join(", ")}`,
    value: amendment.id,
  })),
);

/** Sources in order of presentation: the first one wins a collision. */
const sources = computed<AmendmentDto[]>(() =>
  sourceIds.value
    .map((id) => session.byId.value.get(id))
    .filter((amendment) => amendment !== undefined)
    .sort(
      (a, b) =>
        (a.number ?? Number.MAX_SAFE_INTEGER) -
          (b.number ?? Number.MAX_SAFE_INTEGER) ||
        a.positionKey - b.positionKey,
    ),
);

const parties = computed(() =>
  sessionTransactionalParties(
    sources.value,
    session.document.value?.proponent ?? null,
  ),
);
const partyItems = computed(() =>
  parties.value.map((party) => ({
    label: `${party.member.acronym} · ${party.member.name}`,
    value: party.member.id,
  })),
);

/** Restarts the text from the current sources (the editor is remounted). */
function reseed(): void {
  seed.value = sessionTransactionalSeed(
    session.base.value,
    sources.value.map((amendment) => ({
      id: amendment.id,
      ops: amendment.ops,
    })),
    createId,
  );
  edited.value = seed.value.seed.map((block) => ({
    ...block,
    marks: [...block.marks],
  }));
  editorKey.value += 1;
  const partyIds = new Set(parties.value.map((party) => party.member.id));
  authorIds.value = authorsTouched.value
    ? authorIds.value.filter((id) => partyIds.has(id))
    : parties.value
        .filter((party) => party.role === "author")
        .map((party) => party.member.id);
}

function startFresh(ids: string[]): void {
  discarded = false;
  draftDocumentId.value = session.documentId.value;
  draftDocumentTitle.value = documentTitle(draftDocumentId.value);
  createdId.value = null;
  justification.value = "";
  authorsTouched.value = false;
  sourceIds.value = [...ids];
  reseed();
}

/** Whether the text differs from the seed. Flushes the editor first. */
function textEdited(): boolean {
  // The editor emits with a short delay: take what is on screen right now.
  editor.value?.flush();
  return (
    seed.value !== null && !sessionSameBlocks(edited.value, seed.value.seed)
  );
}

/**
 * A draft not created yet that holds something the Mesa typed or chose,
 * on whichever document it was started: the console moving to another one
 * does not make it any less worth keeping. With the editor unmounted, the
 * text is the one it emitted when it was removed.
 */
function hasDraft(): boolean {
  if (discarded || createdId.value || !seed.value) return false;
  return (
    textEdited() || justification.value.trim() !== "" || authorsTouched.value
  );
}

/** The question before discarding the draft, naming its document if hidden. */
function discardMessage(): string {
  return onOtherDocument.value
    ? t("session.composer.discardOtherConfirm", {
        title: draftDocumentTitle.value,
      })
    : t("session.composer.discardConfirm");
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  const requested = [...session.composer.sourceIds];
  if (!discarded && !createdId.value && seed.value) {
    if (onOtherDocument.value) {
      // A draft left on another document: it cannot continue here, and it
      // is kept for when the console returns there unless the Mesa drops it.
      if (
        hasDraft() &&
        !window.confirm(
          t("session.composer.replaceOtherConfirm", {
            title: draftDocumentTitle.value,
          }),
        )
      ) {
        open.value = false;
        return;
      }
    } else {
      // Reopened for the same amendments: resume the draft as it was.
      if (sessionSameIds(requested, sourceIds.value)) return;
      // Opened for other amendments: keep the draft unless the Mesa drops it.
      if (hasDraft() && !window.confirm(t("session.composer.replaceConfirm"))) {
        return;
      }
    }
  }
  startFresh(requested);
});

// Another Mesa member moved the console to another document. With nothing
// to keep, the panel (about the old document's amendments) just closes.
// With a draft, it stays open and names the document the draft belongs to.
watch(
  () => session.documentId.value,
  () => {
    if (open.value && !hasDraft()) open.value = false;
  },
);

function onSourcesChange(value: string[] | null | undefined): void {
  const next = [...(value ?? [])];
  if (sessionSameIds(next, sourceIds.value)) {
    sourceIds.value = next;
    return;
  }
  // Cancelling leaves the selection as it was: the menu is controlled.
  if (textEdited() && !window.confirm(t("session.composer.reseedConfirm"))) {
    return;
  }
  sourceIds.value = next;
  reseed();
}

function onAuthorsChange(value: string[] | null | undefined): void {
  authorIds.value = [...(value ?? [])];
  authorsTouched.value = true;
}

function resetText(): void {
  if (textEdited() && !window.confirm(t("session.composer.resetConfirm"))) {
    return;
  }
  reseed();
}

/** The footer button: discards the draft, after asking if there is one. */
function cancel(close: () => void): void {
  if (hasDraft()) {
    if (!window.confirm(discardMessage())) return;
    discarded = true;
  }
  close();
}

onBeforeRouteLeave(() => {
  if (!hasDraft()) return true;
  return window.confirm(discardMessage());
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasDraft()) return;
  event.preventDefault();
  event.returnValue = "";
}
onMounted(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() =>
  window.removeEventListener("beforeunload", onBeforeUnload),
);

const ops = computed(() =>
  seed.value && seed.value.passage.length > 0
    ? diffPassage(
        seed.value.passage,
        edited.value,
        seed.value.anchorBefore,
        createId,
      )
    : [],
);
const opErrors = computed(() => validateOps(session.base.value, ops.value));
const skipped = computed(() => seed.value?.skipped ?? []);

const created = computed(() =>
  createdId.value ? (session.byId.value.get(createdId.value) ?? null) : null,
);
// Never while the draft belongs to another document: right after the console
// switches, the new document's data may still hold the old one's, so the
// sources and the checks below would wrongly pass against the wrong URL.
const canCreate = computed(
  () =>
    !onOtherDocument.value &&
    !createdId.value &&
    sources.value.length > 0 &&
    ops.value.length > 0 &&
    opErrors.value.length === 0,
);

async function create(): Promise<void> {
  editor.value?.flush();
  await nextTick();
  if (!canCreate.value) return;
  const result = await session.createTransactional({
    sourceIds: sources.value.map((amendment) => amendment.id),
    ops: ops.value,
    justification: justification.value.trim(),
    authorMemberIds: authorIds.value,
    submit: true,
  });
  if (result) createdId.value = result.id;
}

function debateCreated(): void {
  if (created.value) void session.debateAmendment(created.value);
}

function voteCreated(): void {
  if (!created.value) return;
  const target = created.value;
  open.value = false;
  session.openVote(target);
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    :title="
      created
        ? t('session.composer.createdTitle', { code: created.code ?? '' })
        : t('session.composer.title')
    "
    :description="t('session.composer.description')"
    :ui="{ content: 'w-full max-w-4xl' }"
  >
    <template #body>
      <UAlert
        v-if="onOtherDocument"
        color="warning"
        variant="subtle"
        icon="i-lucide-file-clock"
        :title="t('session.composer.otherDocumentTitle')"
        :description="
          t('session.composer.otherDocument', { title: draftDocumentTitle })
        "
      />
      <div v-else-if="!created" class="space-y-6">
        <UFormField
          :label="t('session.composer.sources')"
          :hint="t('session.composer.sourcesHint')"
          name="composer-sources"
          required
        >
          <USelectMenu
            :model-value="sourceIds"
            :items="sourceItems"
            value-key="value"
            multiple
            :placeholder="t('session.composer.sourcesPlaceholder')"
            :search-input="{ placeholder: t('common.search') }"
            class="w-full"
            @update:model-value="onSourcesChange"
          />
        </UFormField>

        <UAlert
          v-if="skipped.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-git-compare"
          :title="t('session.composer.skippedTitle')"
          :description="
            t('session.composer.skipped', {
              codes: skipped.map(session.label).join(', '),
            })
          "
        />

        <CommonEmptyState
          v-if="sources.length === 0"
          icon="i-lucide-git-merge"
          size="sm"
          :title="t('session.composer.noSources')"
        />
        <CommonEmptyState
          v-else-if="!seed || seed.passage.length === 0"
          icon="i-lucide-file-question"
          size="sm"
          :title="t('session.composer.noPassage')"
          :description="t('session.composer.noPassageHint')"
        />
        <div v-else class="grid gap-4 xl:grid-cols-2">
          <section class="min-w-0 space-y-2">
            <h3 class="text-highlighted text-sm font-medium">
              {{ t("session.composer.text") }}
            </h3>
            <ClientOnly>
              <ContentBlockEditor
                :key="editorKey"
                ref="editor"
                v-model="edited"
                :label="t('session.composer.text')"
                autofocus
              />
              <template #fallback>
                <USkeleton class="h-48 w-full" />
              </template>
            </ClientOnly>
            <UButton
              icon="i-lucide-rotate-ccw"
              color="neutral"
              variant="ghost"
              size="sm"
              :label="t('session.composer.reset')"
              @click="resetText"
            />
          </section>
          <section class="min-w-0 space-y-2" aria-live="polite">
            <h3 class="text-highlighted text-sm font-medium">
              {{ t("session.composer.diff") }}
            </h3>
            <p v-if="ops.length === 0" class="text-muted text-sm">
              {{ t("session.composer.noChanges") }}
            </p>
            <ContentAmendmentDiff
              v-else
              id="transactional-draft"
              :base="session.base.value"
              :ops="ops"
            />
          </section>
        </div>

        <UFormField
          :label="t('session.composer.justification')"
          name="composer-justification"
        >
          <UTextarea
            v-model="justification"
            :rows="3"
            autoresize
            :maxlength="20000"
            class="content-font w-full"
          />
        </UFormField>

        <UFormField
          :label="t('session.composer.authors')"
          :hint="t('session.composer.authorsHint')"
          name="composer-authors"
        >
          <USelectMenu
            :model-value="authorIds"
            :items="partyItems"
            value-key="value"
            multiple
            :placeholder="t('session.composer.authorsPlaceholder')"
            class="w-full"
            @update:model-value="onAuthorsChange"
          />
        </UFormField>

        <section v-if="parties.length > 0" class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.composer.parties") }}
          </h3>
          <p class="text-muted text-sm">
            {{ t("session.composer.partiesHint") }}
          </p>
          <ul class="flex flex-wrap gap-2">
            <li
              v-for="party in parties"
              :key="party.member.id"
              class="inline-flex items-center gap-1"
            >
              <CommonMemberBadge :member="party.member" size="sm" />
              <span class="text-muted text-xs">
                {{ t(`session.enums.acceptanceRole.${party.role}`) }}
              </span>
            </li>
          </ul>
        </section>
      </div>

      <div v-else class="space-y-6">
        <UAlert
          color="success"
          variant="subtle"
          icon="i-lucide-git-merge"
          :title="t('session.composer.created', { code: created.code ?? '' })"
          :description="t('session.composer.createdHint')"
        />
        <SessionAcceptanceList :amendment="created" />
        <section class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.composer.diff") }}
          </h3>
          <ContentAmendmentDiff
            :id="created.id"
            :base="session.base.value"
            :ops="created.ops"
          />
        </section>
      </div>
    </template>

    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="created ? t('common.close') : t('common.cancel')"
          @click="cancel(close)"
        />
        <template v-if="created">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-radio"
            :label="t('session.actions.debate')"
            @click="debateCreated"
          />
          <UButton
            icon="i-lucide-gavel"
            :label="t('session.actions.vote')"
            :disabled="!isSessionDecidable(created)"
            @click="voteCreated"
          />
        </template>
        <UButton
          v-else
          icon="i-lucide-git-merge"
          :label="t('session.composer.submit')"
          :loading="Boolean(session.busy.value.transactional)"
          :disabled="!canCreate"
          @click="create"
        />
      </div>
    </template>
  </USlideover>
</template>
