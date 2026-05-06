import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  agendaItems,
  amendments,
  assemblies,
  documents,
} from "../../db/schema";
import type { DocumentExportData, ExportData } from "./pdfBuilder";

type DocumentRow = Awaited<
  ReturnType<typeof db.query.documents.findMany>
>[number];

type FlatItem = {
  id: string;
  parentId: string | null;
  title: string;
  order: number;
  documents: ExportData["agendaItems"][0]["documents"];
};

async function buildDocumentPayload(doc: DocumentRow) {
  const docAmendments = await db.query.amendments.findMany({
    where: eq(amendments.documentId, doc.id),
    with: {
      author: { columns: { name: true, externalInitials: true } },
    },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  return {
    title: doc.title,
    type: doc.type,
    content: doc.content,
    amendments: docAmendments.map((amendment) => ({
      status: amendment.status,
      type: amendment.type,
      authorName:
        amendment.author?.externalInitials || amendment.author?.name || "-",
      justification: amendment.justification,
    })),
  };
}

function buildTree(
  items: FlatItem[],
  parentId: string | null = null,
  prefix = "",
): ExportData["agendaItems"] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((item, index) => {
      const numbering = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
      return {
        numbering,
        title: item.title,
        documents: item.documents,
        children: buildTree(items, item.id, numbering),
      };
    });
}

export async function buildAssemblyExportData(
  assemblyId: string,
): Promise<ExportData> {
  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
  });

  if (!assembly) {
    throw new Error(`Assembly ${assemblyId} not found`);
  }

  const items = await db.query.agendaItems.findMany({
    where: eq(agendaItems.assemblyId, assemblyId),
    orderBy: (t, { asc }) => [asc(t.order)],
  });

  const flatItems: FlatItem[] = [];
  for (const item of items) {
    const itemDocs = await db.query.documents.findMany({
      where: eq(documents.agendaItemId, item.id),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });

    flatItems.push({
      id: item.id,
      parentId: item.parentId,
      title: item.title,
      order: item.order,
      documents: await Promise.all(itemDocs.map(buildDocumentPayload)),
    });
  }

  return {
    assembly: {
      number: assembly.number,
      type: assembly.type,
      startDate: assembly.startDate.toISOString().split("T")[0]!,
      endDate: assembly.endDate.toISOString().split("T")[0]!,
      location: assembly.location,
    },
    agendaItems: buildTree(flatItems),
  };
}

export async function buildDocumentExportData(
  assemblyId: string,
  itemId: string,
  documentId: string,
): Promise<DocumentExportData> {
  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
  });
  const item = await db.query.agendaItems.findFirst({
    where: eq(agendaItems.id, itemId),
  });
  const document = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });

  if (
    !assembly ||
    !item ||
    item.assemblyId !== assembly.id ||
    !document ||
    document.agendaItemId !== item.id
  ) {
    throw new Error(`Document export target ${documentId} not found`);
  }

  return {
    assembly: {
      number: assembly.number,
      type: assembly.type,
      startDate: assembly.startDate.toISOString().split("T")[0]!,
      endDate: assembly.endDate.toISOString().split("T")[0]!,
      location: assembly.location,
    },
    agendaItemTitle: item.title,
    document: await buildDocumentPayload(document),
  };
}
