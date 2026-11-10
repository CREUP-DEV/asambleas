import { describe, expect, it } from "vitest";
import { titleDocumentPayload } from "./agendaWrites";

describe("titleDocumentPayload", () => {
  it("says nothing of an item written by hand", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: null,
        hiddenWithDocumentId: null,
        titleWithheld: false,
      }),
    ).toEqual({});
  });

  it("marks an automatic sub-item and names its document", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: "d1",
        hiddenWithDocumentId: null,
        titleWithheld: false,
      }),
    ).toEqual({ auto: true, documentId: "d1" });
  });

  it("names the document of one kept after it moved away, no longer automatic", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: null,
        hiddenWithDocumentId: "d1",
        titleWithheld: false,
      }),
    ).toEqual({ documentId: "d1" });
  });

  it("marks one whose title is withheld since its document was deleted", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: null,
        hiddenWithDocumentId: null,
        titleWithheld: true,
      }),
    ).toEqual({ titleWithheld: true });
  });
});
