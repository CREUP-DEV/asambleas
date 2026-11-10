import { describe, expect, it } from "vitest";
import type { AgendaDto, AgendaItemDto } from "~~/shared/types/api";
import { ref } from "vue";
import { agendaWithTitles, withAgendaTitles } from "./agendaTitles";

const item = (
  id: string,
  title: string,
  titleHidden = false,
): AgendaItemDto => ({
  id,
  parentId: null,
  title,
  titleHidden,
  description: null,
  order: 0,
  acceptsSubmissions: false,
  submissionKinds: [],
  auto: false,
  generatedForDocumentId: null,
  titleCustom: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("withAgendaTitles", () => {
  it("labels the items sent without a title and keeps the rest", () => {
    const agenda: AgendaDto = {
      items: [item("a", "Informes"), item("b", "", true)],
      documents: [],
    };
    const shown = withAgendaTitles(agenda, "Hidden");
    expect(shown.items.map((entry) => entry.title)).toEqual([
      "Informes",
      "Hidden",
    ]);
    expect(agenda.items[1]!.title).toBe("");
  });

  it("returns the same agenda when nothing is hidden, and null as it is", () => {
    const agenda: AgendaDto = { items: [item("a", "Informes")], documents: [] };
    expect(withAgendaTitles(agenda, "Hidden")).toBe(agenda);
    expect(withAgendaTitles(null, "Hidden")).toBeNull();
  });
});

describe("agendaWithTitles", () => {
  it("words the label when read, so it follows the language", () => {
    const source = ref<AgendaDto | undefined>({
      items: [item("b", "", true)],
      documents: [],
    });
    const label = ref("Oculto");
    const shown = agendaWithTitles(source, () => label.value);
    expect(shown.value?.items[0]?.title).toBe("Oculto");
    label.value = "Hidden";
    expect(shown.value?.items[0]?.title).toBe("Hidden");
    // The source keeps what the server sent.
    expect(source.value?.items[0]?.title).toBe("");
  });

  it("writes to the source", () => {
    const source = ref<AgendaDto | undefined>(undefined);
    const shown = agendaWithTitles(source, () => "Hidden");
    shown.value = { items: [item("a", "Informes")], documents: [] };
    expect(source.value?.items).toHaveLength(1);
  });
});
