import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

export function computePatch(base: string, modified: string): string {
  const patches = dmp.patch_make(base, modified);
  return dmp.patch_toText(patches);
}

export function applyPatch(base: string, patch: string): string | null {
  const patches = dmp.patch_fromText(patch);
  const [result, success] = dmp.patch_apply(patches, base);

  if (success.some((applied) => !applied)) {
    return null;
  }

  return result;
}

export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
