<script setup lang="ts" generic="T">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AgreementsRecordSigningDto } from "~~/shared/types/api";
import {
  AutoFirmaCancelledError,
  signWithAutoFirma,
} from "~/composables/agreements-record/autofirma";

/**
 * Signing a text (user's decisions of 2026-11-23, 2026-11-26 and
 * 2026-11-28): the acta de acuerdos on its page, a voted document on its
 * «Consolidado», one nothing votes on its own page. Prepare its PDF (with
 * the visible signature of whoever signs from the Intranet, when there is
 * one), sign it with AutoFirma or outside the platform, and publish
 * the signed PDF, which then leads the document. A correction after that
 * takes it away, and it is signed again. Each step answers what the page
 * shows (`T`: the record or the document), handed up by `update`.
 */
const props = defineProps<{
  signing: AgreementsRecordSigningDto | null;
  /** The text may be signed: approved by its final vote. */
  approved: boolean;
  /** The document's title, for the signed file's name. */
  title: string;
  /** The signing's routes: `{base}`, `{base}/prepared`, `{base}/signed`. */
  base: string;
  /** Why it cannot be signed yet, when not approved. */
  notYet: string;
  /** What preparing does, before anything is prepared. */
  intro: string;
  /** A warning above the steps (an acta with a closing of its own). */
  warning?: string | null;
  /** The acta de acuerdos only: corrections it does not hold yet. */
  outdated?: boolean;
  /** The acta de acuerdos only: the route that writes them in. */
  regenerateUrl?: string | null;
  /**
   * Where its texts are: an acta's (the default, «el acta») or any other
   * document's («el documento»), user's decisions of 2026-11-28.
   */
  texts?: "agreementsRecord.signing" | "documentSigning.panel";
  /**
   * Whether its PDF looks for a visible signature: not when a council or
   * a sectorial signs, whose account is no person's.
   */
  image?: boolean;
}>();
const emit = defineEmits<{
  update: [value: T];
  stale: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();

const texts = computed(() => props.texts ?? "agreementsRecord.signing");
const headingId = useId();
const signing = computed(() => props.signing);
const prepared = computed(() =>
  signing.value?.prepared?.current ? signing.value.prepared : null,
);
const signed = computed(() =>
  signing.value?.signed?.current ? signing.value.signed : null,
);

type Busy = "prepare" | "sign" | "upload" | "remove" | "regenerate" | null;
const busy = ref<Busy>(null);
const announcement = ref("");

/**
 * Each step swaps the main button («Preparar para firmar», «Firmar con
 * AutoFirma», «Ver el acta firmada») and disables the others meanwhile, so
 * the focus would fall to the page: once a step ends it goes to the main
 * button, or to the heading when that one is disabled (E-157). Only when
 * the focus was lost, and the dialogs hand it over as they close.
 */
const mainButton = useTemplateRef<{ $el?: HTMLElement }>("mainButton");
const heading = useTemplateRef<HTMLElement>("heading");
function focusMain(): void {
  const button = mainButton.value?.$el;
  if (button?.isConnected && !button.matches(":disabled")) button.focus();
  else heading.value?.focus();
}
watch(busy, async (now, before) => {
  if (now || !before) return;
  await nextTick();
  if (confirmRemove.value || confirmRegenerate.value) return;
  const active = window.document.activeElement;
  if (active && active !== window.document.body && active.isConnected) {
    if (!active.matches(":disabled")) return;
  }
  focusMain();
});
const dialogContent = {
  onCloseAutoFocus: (event: Event) => {
    event.preventDefault();
    focusMain();
  },
};

function done(next: T, key: string): void {
  emit("update", next);
  announcement.value = t(key);
  toast.add({ title: t(key), color: "success", icon: "i-lucide-check" });
}

function failed(error: unknown, key: string): void {
  announcement.value = "";
  api.notifyError(error, key);
  if (api.isConflict(error)) emit("stale");
}

async function prepare(): Promise<void> {
  if (busy.value) return;
  busy.value = "prepare";
  announcement.value = t(`${texts.value}.preparing`);
  try {
    done(
      await api.send<T>(props.base, {
        method: "POST",
      }),
      `${texts.value}.prepared`,
    );
  } catch (error) {
    failed(error, `${texts.value}.prepareFailed`);
  } finally {
    busy.value = null;
  }
}

async function upload(file: Blob, name: string): Promise<void> {
  const body = new FormData();
  body.append("file", file, name);
  body.append("updatedAt", signing.value?.updatedAt ?? "");
  done(
    await api.send<T>(`${props.base}/signed`, {
      body,
    }),
    `${texts.value}.published`,
  );
}

async function signHere(): Promise<void> {
  if (busy.value || !prepared.value) return;
  busy.value = "sign";
  announcement.value = t(`${texts.value}.signing`);
  try {
    const pdf = await $fetch<ArrayBuffer>(`${props.base}/prepared`, {
      responseType: "arrayBuffer",
    });
    let result: Uint8Array<ArrayBuffer>;
    try {
      result = (await signWithAutoFirma(
        new Uint8Array(pdf),
      )) as Uint8Array<ArrayBuffer>;
    } catch (error) {
      announcement.value = "";
      if (error instanceof AutoFirmaCancelledError) return;
      toast.add({
        title: t(`${texts.value}.autofirmaFailed`),
        description: t(`${texts.value}.autofirmaHint`),
        color: "error",
        icon: "i-lucide-circle-alert",
      });
      return;
    }
    await upload(
      new Blob([result], { type: "application/pdf" }),
      `${props.title || "acta"}.pdf`,
    );
  } catch (error) {
    failed(error, `${texts.value}.uploadFailed`);
  } finally {
    busy.value = null;
  }
}

const PDF_MAX_BYTES = 20 * 1024 * 1024;
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const selected = input.files?.[0];
  input.value = "";
  if (!selected || busy.value) return;
  const reject = (key: string) =>
    toast.add({
      title: t(`${texts.value}.uploadFailed`),
      description: t(key),
      color: "error",
      icon: "i-lucide-circle-alert",
    });
  if (selected.type !== "application/pdf" && !/\.pdf$/i.test(selected.name)) {
    reject("document.file.invalidType");
    return;
  }
  if (selected.size > PDF_MAX_BYTES) {
    reject("document.file.tooLarge");
    return;
  }
  busy.value = "upload";
  announcement.value = t("document.file.uploading", { name: selected.name });
  try {
    await upload(selected, selected.name);
  } catch (error) {
    const status = api.errorStatus(error);
    if (status === 415) reject("document.file.invalidType");
    else if (status === 413) reject("document.file.tooLarge");
    else failed(error, `${texts.value}.uploadFailed`);
  } finally {
    busy.value = null;
  }
}

const confirmRemove = ref(false);
async function removeSigned(): Promise<void> {
  if (busy.value) return;
  busy.value = "remove";
  try {
    done(
      await api.send<T>(`${props.base}/signed`, {
        method: "DELETE",
      }),
      `${texts.value}.removed`,
    );
    confirmRemove.value = false;
  } catch (error) {
    failed(error, `${texts.value}.removeFailed`);
  } finally {
    busy.value = null;
  }
}

const confirmRegenerate = ref(false);
async function regenerate(): Promise<void> {
  if (busy.value || !props.regenerateUrl) return;
  busy.value = "regenerate";
  try {
    done(
      await api.send<T>(props.regenerateUrl, {
        method: "POST",
      }),
      "agreementsRecord.signing.regenerated",
    );
    confirmRegenerate.value = false;
  } catch (error) {
    failed(error, "agreementsRecord.signing.regenerateFailed");
  } finally {
    busy.value = null;
  }
}
function askRegenerate(): void {
  // Only a published signature is lost on the way: ask first then.
  if (signing.value?.signed) confirmRegenerate.value = true;
  else void regenerate();
}

const moreItems = computed<DropdownMenuItem[]>(() => {
  const items: DropdownMenuItem[] = [];
  if (prepared.value) {
    items.push(
      {
        label: t(`${texts.value}.download`),
        icon: "i-lucide-download",
        to: `${props.base}/prepared`,
        external: true,
        download: "",
      },
      {
        label: t(`${texts.value}.upload`),
        icon: "i-lucide-file-up",
        onSelect: () => fileInput.value?.click(),
      },
      {
        label: t(`${texts.value}.prepareAgain`),
        icon: "i-lucide-refresh-cw",
        onSelect: () => void prepare(),
      },
    );
  }
  if (signed.value) {
    items.push({
      label: t(`${texts.value}.remove`),
      icon: "i-lucide-file-x",
      color: "error",
      onSelect: () => {
        confirmRemove.value = true;
      },
    });
  }
  return items;
});

function at(value: string): string {
  return formatDateTime(value, { locale: locale.value });
}
</script>

<template>
  <section
    class="border-default space-y-3 rounded-lg border p-4"
    :aria-labelledby="headingId"
  >
    <h3
      :id="headingId"
      ref="heading"
      tabindex="-1"
      class="text-highlighted font-semibold outline-none"
    >
      {{ t(`${texts}.title`) }}
    </h3>

    <p v-if="!approved" class="text-muted text-sm">
      {{ notYet }}
    </p>

    <template v-else>
      <UAlert
        v-if="warning"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="warning"
      />
      <UAlert
        v-if="outdated && regenerateUrl"
        color="warning"
        variant="subtle"
        icon="i-lucide-pencil-line"
        :title="t('agreementsRecord.signing.outdated')"
        :description="
          signing?.signed
            ? t('agreementsRecord.signing.outdatedSigned')
            : t('agreementsRecord.signing.outdatedHint')
        "
        :actions="[
          {
            label: t('agreementsRecord.signing.regenerate'),
            icon: 'i-lucide-refresh-cw',
            loading: busy === 'regenerate',
            onClick: askRegenerate,
          },
        ]"
      />

      <div class="space-y-1 text-sm">
        <p v-if="signed" class="text-default flex items-center gap-2">
          <UIcon
            name="i-lucide-file-check-2"
            class="text-success size-4 shrink-0"
          />
          {{
            t(`${texts}.signedAt`, {
              date: at(signed.signedAt),
            })
          }}
        </p>
        <p v-else-if="prepared" class="text-default flex items-center gap-2">
          <UIcon
            name="i-lucide-file-clock"
            class="text-muted size-4 shrink-0"
          />
          {{ t(`${texts}.preparedAt`, { date: at(prepared.at) }) }}
        </p>
        <p v-else class="text-muted">
          {{ intro }}
        </p>
        <p
          v-if="prepared && !prepared.withImage && !signed && image !== false"
          class="text-muted"
        >
          {{ t(`${texts}.noImage`) }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="signed"
          ref="mainButton"
          icon="i-lucide-file-text"
          color="neutral"
          variant="outline"
          :label="t(`${texts}.view`)"
          :to="signed.url"
          external
          target="_blank"
        />
        <UButton
          v-else-if="prepared"
          ref="mainButton"
          icon="i-lucide-signature"
          :label="t(`${texts}.sign`)"
          :loading="busy === 'sign' || busy === 'upload'"
          :disabled="busy !== null || outdated"
          @click="signHere"
        />
        <UButton
          v-else
          ref="mainButton"
          icon="i-lucide-file-pen-line"
          :label="t(`${texts}.prepare`)"
          :loading="busy === 'prepare'"
          :disabled="busy !== null || outdated"
          @click="prepare"
        />
        <UDropdownMenu
          v-if="moreItems.length > 0"
          :items="moreItems"
          :content="{ align: 'start' }"
        >
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-ellipsis"
            trailing-icon="i-lucide-chevron-down"
            :label="t(`${texts}.more`)"
            :loading="busy === 'prepare' && prepared !== null"
            :disabled="busy !== null"
          />
        </UDropdownMenu>
        <input
          ref="fileInput"
          type="file"
          accept="application/pdf,.pdf"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          @change="onFileChosen"
        />
      </div>
    </template>

    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

    <UModal
      v-model:open="confirmRemove"
      :content="dialogContent"
      :title="t(`${texts}.removeTitle`)"
      :description="t(`${texts}.removeDescription`)"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="busy === 'remove'"
            @click="confirmRemove = false"
          />
          <UButton
            color="error"
            icon="i-lucide-file-x"
            :label="t(`${texts}.remove`)"
            :loading="busy === 'remove'"
            @click="removeSigned"
          />
        </div>
      </template>
    </UModal>
    <UModal
      v-model:open="confirmRegenerate"
      :content="dialogContent"
      :title="t('agreementsRecord.signing.regenerateTitle')"
      :description="t('agreementsRecord.signing.outdatedSigned')"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="busy === 'regenerate'"
            @click="confirmRegenerate = false"
          />
          <UButton
            icon="i-lucide-refresh-cw"
            :label="t('agreementsRecord.signing.regenerate')"
            :loading="busy === 'regenerate'"
            @click="regenerate"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
