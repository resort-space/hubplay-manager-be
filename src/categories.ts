import { GameKind, PricingUnit, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const defaultParents: { billMode: GameKind; name: string }[] = [
  { billMode: GameKind.escape, name: 'Doors Escape' },
  { billMode: GameKind.board, name: 'Board game' },
  { billMode: GameKind.board, name: 'Kịch bản sát' },
];

export async function ensureDefaultCategories(db: Db, venueId: string) {
  await db.gameCategory.updateMany({
    where: { venueId, billMode: GameKind.sat },
    data: { billMode: GameKind.board },
  });
  await db.subGame.updateMany({
    where: {
      venueId,
      pricingUnit: PricingUnit.per_hour,
      category: { billMode: { not: GameKind.escape } },
    },
    data: { pricingUnit: PricingUnit.per_session },
  });
  for (const item of defaultParents) {
    const found = await db.gameCategory.findFirst({ where: { venueId, name: item.name } });
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
