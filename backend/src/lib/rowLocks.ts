import { Prisma } from "@prisma/client";

/** Parent locks also block new foreign-key references until guarded deletes commit. */
export async function lockRow(
  tx: Prisma.TransactionClient,
  table: "Branch" | "Subject" | "Flashcard" | "StudyGroup",
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id} FOR UPDATE`,
  );
  return rows.length > 0;
}

/** Serialize completion/catch-up changes for one owned plan to avoid lost JSON updates. */
export async function lockPlan(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "StudyPlan" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`,
  );
}
