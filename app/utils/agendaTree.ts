export interface FlatAgendaItem {
  id: string;
  assemblyId: string;
  parentId: string | null;
  title: string;
  order: number;
  allowDocumentSubmission: boolean;
  documentSubmissionDeadline: string | Date | null;
  allowAmendments: boolean;
  amendmentDeadline: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface AgendaTreeNode extends FlatAgendaItem {
  children: AgendaTreeNode[];
  depth: number;
  number: string;
}

export function buildAgendaTree(items: FlatAgendaItem[]): AgendaTreeNode[] {
  const byId = new Map<string, AgendaTreeNode>();

  for (const item of items) {
    byId.set(item.id, { ...item, children: [], depth: 0, number: "" });
  }

  const roots: AgendaTreeNode[] = [];

  for (const node of byId.values()) {
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  const sortByOrder = (nodes: AgendaTreeNode[]) =>
    nodes.sort((a, b) => a.order - b.order);

  function assignNumbers(
    nodes: AgendaTreeNode[],
    prefix: string,
    depth: number,
  ) {
    sortByOrder(nodes);
    nodes.forEach((node, i) => {
      node.depth = depth;
      node.number = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      assignNumbers(node.children, node.number, depth + 1);
    });
  }

  sortByOrder(roots);
  assignNumbers(roots, "", 0);

  return roots;
}

export function flattenTree(nodes: AgendaTreeNode[]): AgendaTreeNode[] {
  const result: AgendaTreeNode[] = [];
  function walk(items: AgendaTreeNode[]) {
    for (const item of items) {
      result.push(item);
      walk(item.children);
    }
  }
  walk(nodes);
  return result;
}
