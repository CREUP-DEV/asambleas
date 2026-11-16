import { describe, expect, it, vi } from "vitest";

// The rows of GET /api/admin/users as the client reads them, with no
// per-user grants in the stubbed database.
vi.mock("../../db", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: async () => [],
  };
  return { db: { select: () => chain } };
});

const { ADMIN_USER_COLUMNS, ADMIN_USER_RELATIONS, withExtraPermissions } =
  await import("./adminUsers");

const FILE = "AbCdEfGhIjKlMnOpQrStUvWxYz012345-0123456789abcdef.webp";

function row(avatar: { file: string | null } | null) {
  return {
    id: "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    name: "Consejo",
    universityAcronym: "UGR",
    member: null,
    avatar,
  };
}

describe("the photo of an admin users row", () => {
  it("is read from the stored photo, never users.image", () => {
    expect(ADMIN_USER_COLUMNS).not.toHaveProperty("image");
    expect(ADMIN_USER_RELATIONS.avatar).toEqual({ columns: { file: true } });
  });

  it("is the stored photo's URL, or null without one", async () => {
    const [stored, unusable, none] = await withExtraPermissions([
      row({ file: FILE }),
      row({ file: null }),
      row(null),
    ]);
    expect(stored).toMatchObject({ image: `/api/uploads/avatars/${FILE}` });
    expect(stored).not.toHaveProperty("avatar");
    expect(unusable!.image).toBeNull();
    expect(none!.image).toBeNull();
    expect(none!.avatarText).toBe("UGR");
  });
});
