import { describe, expect, it } from "vitest";
import {
  addAfterOf,
  addAnotherPath,
  agendaItemAnchor,
  agendaItemPath,
  editorFrom,
  nextItemId,
  originOf,
  originPath,
} from "./agendaReturn";

const hub = "/asambleas/80-ago";

describe("agenda return", () => {
  it("opens the editor remembering where it was added from", () => {
    for (const origin of ["agenda", "home"] as const) {
      const path = editorFrom(`${hub}/documentos/informe`, origin);
      const query = Object.fromEntries(new URL(path, "http://x").searchParams);
      expect(originOf(query)).toBe(origin);
    }
    expect(editorFrom(`${hub}/documentos/informe`, "home")).toBe(
      `${hub}/documentos/informe/editar?desde=inicio`,
    );
  });

  it("ignores any other origin", () => {
    expect(originOf({})).toBeNull();
    expect(originOf({ desde: "documentos" })).toBeNull();
    expect(originOf({ desde: ["orden-del-dia", "x"] })).toBe("agenda");
  });

  it("goes back to the page, the agenda organized at the item", () => {
    expect(originPath("agenda", hub, "abc")).toBe(
      `${hub}/orden-del-dia?organizar=1#${agendaItemAnchor("abc")}`,
    );
    expect(originPath("home", hub, "abc")).toBe(hub);
  });

  it("names the page of an item by its id", () => {
    expect(agendaItemPath(hub, "abc")).toBe(`${hub}/orden-del-dia/abc`);
    expect(agendaItemPath(hub, "a/b")).toBe(`${hub}/orden-del-dia/a%2Fb`);
  });

  it("asks the page to add another after the item", () => {
    const path = addAnotherPath("home", hub, "abc");
    expect(path).toBe(`${hub}?nuevo=abc`);
    const query = Object.fromEntries(new URL(path, "http://x").searchParams);
    expect(addAfterOf(query)).toBe("abc");
    expect(addAfterOf({ nuevo: "" })).toBeNull();
  });

  it("picks the next item without documents, going round", () => {
    const items = (spec: string) =>
      [...spec].map((id) => ({ id, hasDocuments: id === id.toUpperCase() }));
    // Lower case: no documents yet.
    expect(nextItemId(items("aBc"), "a")).toBe("c");
    expect(nextItemId(items("abc"), "c")).toBe("a");
    expect(nextItemId(items("aB"), "gone")).toBe("a");
    // Every item has documents: simply the next one.
    expect(nextItemId(items("ABC"), "A")).toBe("B");
    expect(nextItemId([], "a")).toBeNull();
  });
});
