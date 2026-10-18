import { GameKind, PricingUnit, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const defaultParents: { billMode: GameKind; name: string }[] = [
  { billMode: GameKind.escape, name: 'Doors Escape' },
  { billMode: GameKind.board, name: 'Board game' },
  { billMode: GameKind.sat, name: 'Kịch bản sát' },
];

export const defaultSatGames: { code: string; name: string; minPlayers: number; maxPlayers: number; duration: string; basePrice: number; nightPrice: number }[] = [
  { code: 'SAT-01', name: 'GƯƠNG', minPlayers: 4, maxPlayers: 4, duration: '3h', basePrice: 179000, nightPrice: 219000 },
  { code: 'SAT-02', name: 'LÊN ĐƯỜNG', minPlayers: 5, maxPlayers: 5, duration: '4h', basePrice: 189000, nightPrice: 229000 },
  { code: 'SAT-03', name: 'THƯỢC DƯỢC ĐEN', minPlayers: 5, maxPlayers: 5, duration: '3.5-4h', basePrice: 199000, nightPrice: 239000 },
  { code: 'SAT-04', name: '100 CÁCH CHẾT CỦA NYC', minPlayers: 5, maxPlayers: 5, duration: '3h', basePrice: 159000, nightPrice: 199000 },
  { code: 'SAT-05', name: 'NIÊN LUÂN', minPlayers: 5, maxPlayers: 5, duration: '4h', basePrice: 229000, nightPrice: 269000 },
  { code: 'SAT-06', name: 'GỌI BỐ', minPlayers: 5, maxPlayers: 5, duration: '4-5h', basePrice: 239000, nightPrice: 279000 },
  { code: 'SAT-07', name: 'SINH TỬ', minPlayers: 5, maxPlayers: 5, duration: '3h', basePrice: 179000, nightPrice: 219000 },
  { code: 'SAT-08', name: 'CÔ GÁI BÊN CỬA SỔ', minPlayers: 6, maxPlayers: 6, duration: '3h', basePrice: 159000, nightPrice: 199000 },
  { code: 'SAT-09', name: 'ĐIÊU DÂN', minPlayers: 6, maxPlayers: 6, duration: '3h', basePrice: 169000, nightPrice: 209000 },
  { code: 'SAT-10', name: 'HẬU CUNG', minPlayers: 6, maxPlayers: 6, duration: '4h', basePrice: 229000, nightPrice: 269000 },
  { code: 'SAT-11', name: 'CỔ THỤ NGÂN NGA', minPlayers: 6, maxPlayers: 6, duration: '5h', basePrice: 259000, nightPrice: 299000 },
  { code: 'SAT-12', name: 'XIN CHÀO', minPlayers: 6, maxPlayers: 6, duration: '4h', basePrice: 199000, nightPrice: 239000 },
  { code: 'SAT-13', name: 'CUỘC GỌI ĐẾN', minPlayers: 6, maxPlayers: 6, duration: '4h', basePrice: 189000, nightPrice: 229000 },
  { code: 'SAT-14', name: 'GIÀY THÊU HOA', minPlayers: 6, maxPlayers: 6, duration: '4h', basePrice: 249000, nightPrice: 289000 },
  { code: 'SAT-15', name: '1H30', minPlayers: 6, maxPlayers: 6, duration: '4h', basePrice: 189000, nightPrice: 229000 },
  { code: 'SAT-16', name: 'TUYẾT HƯƠNG LIÊN HOÀN ÁN', minPlayers: 6, maxPlayers: 6, duration: '3.5-4h', basePrice: 249000, nightPrice: 289000 },
  { code: 'SAT-17', name: 'TỘI DIỄN SƯ', minPlayers: 6, maxPlayers: 7, duration: '4h', basePrice: 199000, nightPrice: 239000 },
  { code: 'SAT-18', name: 'THANH LÂU', minPlayers: 7, maxPlayers: 7, duration: '6h', basePrice: 299000, nightPrice: 339000 },
  { code: 'SAT-19', name: 'TỬU', minPlayers: 7, maxPlayers: 7, duration: '4h', basePrice: 249000, nightPrice: 289000 },
  { code: 'SAT-20', name: 'YANDERE NK TÂM THẦN PHÂN LIỆT 1', minPlayers: 7, maxPlayers: 7, duration: '4h', basePrice: 189000, nightPrice: 229000 },
  { code: 'SAT-21', name: 'KIẾM TIỀN', minPlayers: 7, maxPlayers: 10, duration: '4-5h', basePrice: 189000, nightPrice: 229000 },
];

export async function ensureDefaultCategories(db: Db, venueId: string) {
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
  await db.gameCategory.updateMany({
    where: { venueId, name: 'Kịch bản sát', billMode: { not: GameKind.sat } },
    data: { billMode: GameKind.sat },
  });
  const satRoom = await db.gameCategory.findFirst({ where: { venueId, billMode: GameKind.sat }, orderBy: { id: 'asc' } });
  if (!satRoom) return;
  const existing = await db.subGame.findMany({
    where: { venueId, code: { in: defaultSatGames.map((game) => game.code) } },
    select: { code: true },
  });
  const have = new Set(existing.map((game) => game.code));
  const missing = defaultSatGames.filter((game) => !have.has(game.code));
  if (!missing.length) return;
  await db.subGame.createMany({
    data: missing.map((game) => ({
      venueId,
      categoryId: satRoom.id,
      name: game.name,
      code: game.code,
      basePrice: game.basePrice,
      nightPrice: game.nightPrice,
      minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers,
      duration: game.duration,
      pricingUnit: PricingUnit.per_session,
    })),
  });
}

export async function ensureEscapeCategory(db: Db, venueId: string) {
  const found = await db.gameCategory.findFirst({
    where: { venueId, billMode: GameKind.escape },
    orderBy: { id: 'asc' },
  });
  if (found) return found;
  return db.gameCategory.create({ data: { venueId, billMode: GameKind.escape, name: 'Doors Escape' } });
}
