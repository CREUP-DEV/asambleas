import { describe, expect, it } from "vitest";
import {
  agendaAtItem,
  agendaItemAnchor,
  cameFromAgenda,
  editorFromAgenda,
} from "./agendaReturn";

describe("agenda return", () => {
  it("opens the editor remembering the agenda", () => {
    const path = editorFromAgenda("/asambleas/80-ago/documentos/informe");
    expect(path).toBe(
      "/asambleas/80-ago/documentos/informe/editar?desde=orden-del-dia",
    );
    const query = Object.fromEntries(new URL(path, "http://x").searchParams);
    expect(cameFromAgenda(query)).toBe(true);
  });

  it("ignores any other origin", () => {
    expect(cameFromAgenda({})).toBe(false);
    expect(cameFromAgenda({ desde: "documentos" })).toBe(false);
    expect(cameFromAgenda({ desde: ["orden-del-dia", "x"] })).toBe(true);
  });

  it("goes back to the item, organized", () => {
    expect(agendaAtItem("/asambleas/80-ago/orden-del-dia", "abc")).toBe(
      `/asambleas/80-ago/orden-del-dia?organizar=1#${agendaItemAnchor("abc")}`,
    );
  });
});
