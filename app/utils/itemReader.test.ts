import { describe, expect, it } from "vitest";
import { itemReaderPosition } from "./itemReader";

const doc = (id: string, agendaItemId: string) => ({
  id,
  slug: `slug-${id}`,
  agendaItemId,
});

const ordered = [
  doc("a", "one"),
  doc("b", "two"),
  doc("c", "two"),
  doc("d", "two"),
  doc("e", "four"),
];

describe("itemReaderPosition", () => {
  it("opens the item's first document when none is asked for", () => {
    const position = itemReaderPosition(ordered, "two", null);
    expect(position.here.map((d) => d.id)).toEqual(["b", "c", "d"]);
    expect(position.current?.id).toBe("b");
    expect(position.index).toBe(0);
  });

  it("opens the one in the address, by slug or id", () => {
    expect(itemReaderPosition(ordered, "two", "slug-c").current?.id).toBe("c");
    expect(itemReaderPosition(ordered, "two", "d").current?.id).toBe("d");
  });

  it("falls back to the first one for a document of another item", () => {
    expect(itemReaderPosition(ordered, "two", "slug-e").current?.id).toBe("b");
    expect(itemReaderPosition(ordered, "two", "nope").current?.id).toBe("b");
  });

  it("walks the whole agenda across items", () => {
    const first = itemReaderPosition(ordered, "two", "slug-b");
    expect(first.previous?.id).toBe("a");
    expect(first.next?.id).toBe("c");
    const last = itemReaderPosition(ordered, "two", "slug-d");
    expect(last.index).toBe(2);
    expect(last.next?.id).toBe("e");
    expect(itemReaderPosition(ordered, "one", null).previous).toBeNull();
    expect(itemReaderPosition(ordered, "four", null).next).toBeNull();
  });

  it("has nothing to show in an item without documents", () => {
    expect(itemReaderPosition(ordered, "three", "slug-b")).toEqual({
      here: [],
      current: null,
      index: -1,
      previous: null,
      next: null,
    });
  });
});
