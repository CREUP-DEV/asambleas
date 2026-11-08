import { describe, expect, it } from "vitest";
import {
  addAfterOf,
  addAnotherPath,
  agendaItemAnchor,
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

  it("asks the page to add another after the item", () => {
    const path = addAnotherPath("home", hub, "abc");
    expect(path).toBe(`${hub}?nuevo=abc`);
    const query = Object.fromEntries(new URL(path, "http://x").searchParams);
    expect(addAfterOf(query)).toBe("abc");
    expect(addAfterOf({ nuevo: "" })).toBeNull();
  });

  it("picks the next item, wrapping to the first", () => {
    expect(nextItemId(["a", "b", "c"], "a")).toBe("b");
    expect(nextItemId(["a", "b", "c"], "c")).toBe("a");
    expect(nextItemId(["a", "b"], "gone")).toBe("a");
    expect(nextItemId([], "a")).toBeNull();
  });
});
