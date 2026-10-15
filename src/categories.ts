import { GameKind, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const defaultParents: { billMode: GameKind; name: string }[] = [
  { billMode: GameKind.escape, name: 'Doors Escape' },
  { billMode: GameKind.board, name: 'Board game' },
  { billMode: GameKind.sat, name: 'Kịch bản sát' },
];

export async function ensureDefaultCategories(db: Db, venueId: string) {
  for (const item of defaultParents) {
    const found = await db.gameCategory.findFirst({ where: { venueId, billMode: item.billMode } });
    if (!found) await db.gameCategory.create({ data: { venueId, billMode: item.billMode, name: item.name } });
  }
}

export async function ensureEscapeCategory(db: Db, venueId: string) {
  const found = await db.gameCategory.findFirst({
    where: { venueId, billMode: GameKind.escape },
    orderBy: { id: 'asc' },
  });
  if (found) return found;
  return db.gameCategory.create({ data: { venueId, billMode: GameKind.escape, name: 'Doors Escape' } });
}
