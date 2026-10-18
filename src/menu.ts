import { MenuKind, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const defaultMenu: { kind: MenuKind; name: string; price: number }[] = [
  { kind: MenuKind.drink, name: 'Trà chanh', price: 20000 },
  { kind: MenuKind.drink, name: 'Trà tắc', price: 20000 },
  { kind: MenuKind.drink, name: 'Trà tắc xí muội', price: 25000 },
  { kind: MenuKind.drink, name: 'Cà phê đen đá', price: 20000 },
  { kind: MenuKind.drink, name: 'Cà phê sữa đá', price: 25000 },
  { kind: MenuKind.drink, name: 'Bạc xỉu', price: 30000 },
  { kind: MenuKind.drink, name: 'Matcha latte', price: 30000 },
  { kind: MenuKind.drink, name: 'Matcha sữa đá', price: 30000 },
  { kind: MenuKind.drink, name: 'Sinh tố xoài', price: 30000 },
  { kind: MenuKind.drink, name: 'Nước ép cam', price: 30000 },
  { kind: MenuKind.drink, name: 'Sinh tố dưa hấu', price: 30000 },
  { kind: MenuKind.drink, name: 'Nước suối', price: 15000 },
  { kind: MenuKind.drink, name: 'Trà xanh Không Độ', price: 20000 },
  { kind: MenuKind.drink, name: 'Trà cozy', price: 20000 },
  { kind: MenuKind.drink, name: 'Sting', price: 20000 },
  { kind: MenuKind.drink, name: 'Number 1', price: 20000 },
  { kind: MenuKind.drink, name: 'Milo hộp', price: 15000 },
  { kind: MenuKind.drink, name: 'Red Bull', price: 20000 },
  { kind: MenuKind.drink, name: 'Twister cam', price: 20000 },
  { kind: MenuKind.drink, name: 'C2', price: 20000 },
  { kind: MenuKind.drink, name: 'Mirinda cam', price: 20000 },
  { kind: MenuKind.food, name: 'Xúc xích chiên', price: 10000 },
  { kind: MenuKind.food, name: 'Khoai tây chiên', price: 25000 },
  { kind: MenuKind.food, name: 'Khoai tây chiên', price: 20000 },
  { kind: MenuKind.food, name: 'Bim bim', price: 15000 },
  { kind: MenuKind.food, name: 'Mì trộn xúc xích', price: 25000 },
  { kind: MenuKind.food, name: 'Mì trộn trứng', price: 25000 },
  { kind: MenuKind.food, name: 'Mì trộn đặc biệt', price: 30000 },
];

export async function ensureDefaultMenu(db: Db, venueId: string) {
  const existing = await db.drink.findMany({ where: { venueId }, select: { kind: true, name: true, price: true } });
  const have = new Set(existing.map((row) => `${row.kind}\0${row.name}\0${row.price}`));
  const missing = defaultMenu.filter((item) => !have.has(`${item.kind}\0${item.name}\0${item.price}`));
  if (!missing.length) return;
  await db.drink.createMany({
    data: missing.map((item) => ({ venueId, kind: item.kind, name: item.name, price: item.price })),
  });
}

export async function syncDefaultMenuPrices(db: Db, venueId: string) {
  const prices = new Map<string, { kind: MenuKind; name: string; values: number[] }>();
  for (const item of defaultMenu) {
    const key = `${item.kind}\0${item.name}`;
    const row = prices.get(key) ?? { kind: item.kind, name: item.name, values: [] };
    row.values.push(item.price);
    prices.set(key, row);
  }
  let updated = 0;
  const skipped: string[] = [];
  for (const row of prices.values()) {
    const unique = [...new Set(row.values)];
    if (unique.length !== 1) {
      skipped.push(row.name);
      continue;
    }
    const result = await db.drink.updateMany({
      where: { venueId, kind: row.kind, name: row.name },
      data: { price: unique[0] },
    });
    updated += result.count;
  }
  return { updated, skipped };
}
