import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { createId } from "@paralleldrive/cuid2";

/**
 * Keeps a stable `blockId` attribute on every paragraph and heading of the
 * TipTap document, so block ids survive editing (see shared/utils/content/
 * editor.ts for the conversion to blocks).
 *
 * - Nodes without an id get a fresh one.
 * - Duplicated ids (paste, split, copy within the document) are resolved:
 *   the node that already carried the id before the change keeps it, and any
 *   copy gets a fresh id. A split paragraph keeps its id on the first half,
 *   except when that half is empty (Enter at the very start), where the id
 *   stays with the text that moved down.
 * - Ids are never read from pasted HTML, so content copied from another
 *   document cannot hijack the ids of this one.
 */

export const BLOCK_ID_NODE_TYPES = ["paragraph", "heading"] as const;
export const blockIdPluginKey = new PluginKey("blockId");

const TYPES = new Set<string>(BLOCK_ID_NODE_TYPES);

function idOf(node: ProseMirrorNode): string | null {
  const value = node.attrs.blockId;
  return typeof value === "string" && value ? value : null;
}

/** Where each id lived before the transactions (mapped forward) and its text. */
export interface PreviousBlock {
  pos: number;
  text: string;
}

function previousBlocks(
  oldState: EditorState,
  transactions: readonly Transaction[],
): Map<string, PreviousBlock> {
  const blocks = new Map<string, PreviousBlock>();
  oldState.doc.descendants((node, pos) => {
    if (!TYPES.has(node.type.name)) return true;
    const id = idOf(node);
    if (id && !blocks.has(id)) {
      let mapped = pos;
      for (const tr of transactions) mapped = tr.mapping.map(mapped, -1);
      blocks.set(id, { pos: mapped, text: node.textContent });
    }
    return false;
  });
  return blocks;
}

interface Occurrence {
  pos: number;
  node: ProseMirrorNode;
  id: string | null;
}

/**
 * Picks the occurrence that keeps a duplicated id: the one still holding the
 * previous text (Enter at the start of a paragraph moves the text down), else
 * the one at the previous position (the first half of a split), else the
 * first in the document.
 */
function pickKeeper(
  group: Occurrence[],
  previous: PreviousBlock | undefined,
): Occurrence {
  if (group.length === 1 || !previous) return group[0]!;
  const sameText = group.filter(
    (entry) => entry.node.textContent === previous.text,
  );
  const pool = sameText.length > 0 ? sameText : group;
  return pool.find((entry) => entry.pos === previous.pos) ?? pool[0]!;
}

/** A transaction assigning ids where missing or duplicated, or null. */
export function fixBlockIds(
  state: EditorState,
  previous: Map<string, PreviousBlock> = new Map(),
  newId: () => string = createId,
): Transaction | null {
  const groups = new Map<string, Occurrence[]>();
  const missing: Occurrence[] = [];
  state.doc.descendants((node, pos) => {
    if (!TYPES.has(node.type.name)) return true;
    const entry: Occurrence = { pos, node, id: idOf(node) };
    if (entry.id) {
      const group = groups.get(entry.id) ?? [];
      group.push(entry);
      groups.set(entry.id, group);
    } else {
      missing.push(entry);
    }
    // Paragraphs and headings hold inline content only.
    return false;
  });

  const renew: Occurrence[] = [...missing];
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    const keeper = pickKeeper(group, previous.get(id));
    renew.push(...group.filter((entry) => entry !== keeper));
  }
  if (renew.length === 0) return null;

  // setNodeMarkup keeps node sizes, so positions stay valid.
  const tr = state.tr;
  for (const { pos, node } of renew) {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: newId() });
  }
  return tr;
}

export const BlockIdExtension = Extension.create({
  name: "blockId",

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_ID_NODE_TYPES],
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: (attributes) =>
              typeof attributes.blockId === "string" && attributes.blockId
                ? { "data-block-id": attributes.blockId }
                : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdPluginKey,
        appendTransaction(transactions, oldState, newState) {
          const relevant = transactions.some(
            (tr) => tr.docChanged || tr.getMeta(blockIdPluginKey),
          );
          if (!relevant) return null;
          // Appended to the same history event, so one undo reverts both.
          return fixBlockIds(newState, previousBlocks(oldState, transactions));
        },
      }),
    ];
  },

  onCreate() {
    // The initial content never goes through appendTransaction; normalise it
    // once, outside the undo history.
    const tr = fixBlockIds(this.editor.state);
    if (tr) {
      tr.setMeta("addToHistory", false);
      this.editor.view.dispatch(tr);
    }
  },
});
