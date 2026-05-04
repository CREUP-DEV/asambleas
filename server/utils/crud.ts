import { createError } from "h3";
import { db } from "../db";

type CrudTransaction = Parameters<typeof db.transaction>[0];
type CrudTransactionContext = Parameters<CrudTransaction>[0];

export async function runCrudTransaction<T>(
  mutation: (tx: CrudTransactionContext) => Promise<T | null | undefined>,
  errorMessage: string,
): Promise<NonNullable<T>> {
  const result = await db.transaction(mutation);

  if (result == null) {
    throw createError({
      statusCode: 500,
      message: errorMessage,
    });
  }

  return result as NonNullable<T>;
}
