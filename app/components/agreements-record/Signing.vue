<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import {
  AutoFirmaCancelledError,
  signWithAutoFirma,
} from "~/composables/agreements-record/autofirma";

/**
 * Signing the approved acta de acuerdos (user's decisions of 2026-11-23):
 * prepare its PDF (with the visible signature of the Secretaría Ejecutiva
 * from the Intranet), sign it with AutoFirma or outside the platform, and
 * publish the signed PDF, which then leads the document. A correction
 * after that regenerates the record, and it is signed again.
 */
const props = defineProps<{
  record: AgreementsRecordDto;
  /** The assembly's API base. */
  apiBase: string;
}>();
const emit = defineEmits<{
  update: [record: AgreementsRecordDto];
  stale: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();

const base = computed(() => `${props.apiBase}/agreements-record`);
const document = computed(() => props.record.document);
const signing = computed(() => props.record.signing);
const prepared = computed(() =>
  signing.value?.prepared?.current ? signing.value.prepared : null,
);
const signed = computed(() =>
  signing.value?.signed?.current ? signing.value.signed : null,
);

type Busy = "prepare" | "sign" | "upload" | "remove" | "regenerate" | null;
const busy = ref<Busy>(null);
const announcement = ref("");

function done(next: AgreementsRecordDto, key: string): void {
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
  announcement.value = t("agreementsRecord.signing.preparing");
  try {
    done(
      await api.send<AgreementsRecordDto>(`${base.value}/signing`, {
        method: "POST",
      }),
      "agreementsRecord.signing.prepared",
    );
  } catch (error) {
    failed(error, "agreementsRecord.signing.prepareFailed");
  } finally {
    busy.value = null;
  }
}

async function upload(file: Blob, name: string): Promise<void> {
  const body = new FormData();
  body.append("file", file, name);
  body.append("updatedAt", signing.value?.updatedAt ?? "");
  done(
    await api.send<AgreementsRecordDto>(`${base.value}/signing/signed`, {
      body,
    }),
    "agreementsRecord.signing.published",
  );
}

async function signHere(): Promise<void> {
  if (busy.value || !prepared.value) return;
  busy.value = "sign";
  announcement.value = t("agreementsRecord.signing.signing");
  try {
    const pdf = await $fetch<ArrayBuffer>(`${base.value}/signing/prepared`, {
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
        title: t("agreementsRecord.signing.autofirmaFailed"),
        description: t("agreementsRecord.signing.autofirmaHint"),
        color: "error",
        icon: "i-lucide-circle-alert",
      });
      return;
    }
    await upload(
      new Blob([result], { type: "application/pdf" }),
      `${document.value?.title ?? "acta"}.pdf`,
    );
  } catch (error) {
    failed(error, "agreementsRecord.signing.uploadFailed");
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
      title: t("agreementsRecord.signing.uploadFailed"),
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
    else failed(error, "agreementsRecord.signing.uploadFailed");
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
      await api.send<AgreementsRecordDto>(`${base.value}/signing/signed`, {
        method: "DELETE",
      }),
      "agreementsRecord.signing.removed",
    );
    confirmRemove.value = false;
  } catch (error) {
    failed(error, "agreementsRecord.signing.removeFailed");
  } finally {
    busy.value = null;
  }
}

const confirmRegenerate = ref(false);
async function regenerate(): Promise<void> {
  if (busy.value) return;
  busy.value = "regenerate";
  try {
    done(
      await api.send<AgreementsRecordDto>(`${base.value}/regenerate`, {
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
        label: t("agreementsRecord.signing.download"),
        icon: "i-lucide-download",
        to: `${base.value}/signing/prepared`,
        external: true,
        download: "",
      },
      {
        label: t("agreementsRecord.signing.upload"),
        icon: "i-lucide-file-up",
        onSelect: () => fileInput.value?.click(),
      },
      {
        label: t("agreementsRecord.signing.prepareAgain"),
        icon: "i-lucide-refresh-cw",
        onSelect: () => void prepare(),
      },
    );
  }
  if (signed.value) {
    items.push({
      label: t("agreementsRecord.signing.remove"),
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
    v-if="document"
    class="border-default space-y-3 rounded-lg border p-4"
    aria-labelledby="agreements-signing-title"
  >
    <h3 id="agreements-signing-title" class="text-highlighted font-semibold">
      {{ t("agreementsRecord.signing.title") }}
    </h3>

    <p v-if="!document.approved" class="text-muted text-sm">
      {{ t("agreementsRecord.signing.notYet") }}
    </p>

    <template v-else>
      <UAlert
        v-if="document.outdated"
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
            t("agreementsRecord.signing.signedAt", {
              date: at(signed.signedAt),
            })
          }}
        </p>
        <p v-else-if="prepared" class="text-default flex items-center gap-2">
          <UIcon
            name="i-lucide-file-clock"
            class="text-muted size-4 shrink-0"
          />
          {{
            t("agreementsRecord.signing.preparedAt", { date: at(prepared.at) })
          }}
        </p>
        <p v-else class="text-muted">
          {{ t("agreementsRecord.signing.intro") }}
        </p>
        <p v-if="prepared && !prepared.withImage && !signed" class="text-muted">
          {{ t("agreementsRecord.signing.noImage") }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="signed"
          icon="i-lucide-file-text"
          color="neutral"
          variant="outline"
          :label="t('agreementsRecord.signing.view')"
          :to="signed.url"
          external
          target="_blank"
        />
        <UButton
          v-else-if="prepared"
          icon="i-lucide-signature"
          :label="t('agreementsRecord.signing.sign')"
          :loading="busy === 'sign' || busy === 'upload'"
          :disabled="busy !== null || document.outdated"
          @click="signHere"
        />
        <UButton
          v-else
          icon="i-lucide-file-pen-line"
          :label="t('agreementsRecord.signing.prepare')"
          :loading="busy === 'prepare'"
          :disabled="busy !== null || document.outdated"
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
            :label="t('agreementsRecord.signing.more')"
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
      :title="t('agreementsRecord.signing.removeTitle')"
      :description="t('agreementsRecord.signing.removeDescription')"
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
            :label="t('agreementsRecord.signing.remove')"
            :loading="busy === 'remove'"
            @click="removeSigned"
          />
        </div>
      </template>
    </UModal>
    <UModal
      v-model:open="confirmRegenerate"
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
