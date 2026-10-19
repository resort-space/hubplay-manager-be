import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient, AdminRole, GameKind } from '@prisma/client';
import { hash } from 'bcryptjs';
import { ensureDefaultCategories } from '../src/categories';
import { ensureDefaultMenu } from '../src/menu';

function loadEnvFile() {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();
const seedPassword = process.env.SEED_ADMIN_PASSWORD?.trim() ?? '';
if (!seedPassword) {
  console.error('Thiếu SEED_ADMIN_PASSWORD');
  process.exit(1);
}

const prisma = new PrismaClient();

const slots = [
  [1, '09:00', '10:00'],
  [2, '10:15', '11:15'],
  [3, '11:30', '12:30'],
  [4, '12:45', '13:45'],
  [5, '14:00', '15:00'],
  [6, '15:15', '16:15'],
  [7, '16:30', '17:30'],
  [8, '17:45', '18:45'],
  [9, '19:00', '20:00'],
  [10, '20:15', '21:15'],
  [11, '21:30', '22:30'],
  [12, '22:45', '23:45'],
  [13, '23:00', '24:00'],
] as const;

async function main() {
  const venue = await prisma.venue.upsert({
    where: { code: 'DER' },
    update: { name: 'Door Escape', address: '6 ngõ 78 đường Lương Ngọc Quyến' },
    create: {
      code: 'DER',
      name: 'Door Escape',
      address: '6 ngõ 78 đường Lương Ngọc Quyến',
      phone: '',
    },
  });

  for (const [slotIndex, startTime, endTime] of slots) {
    await prisma.timeSlot.upsert({
      where: { venueId_slotIndex: { venueId: venue.id, slotIndex } },
      update: { startTime, endTime },
      create: { venueId: venue.id, slotIndex, startTime, endTime },
    });
  }

  await placeCategories();
  const escape = await prisma.gameCategory.findFirstOrThrow({
    where: { venueId: venue.id, billMode: GameKind.escape },
    orderBy: { id: 'asc' },
  });

  const rooms = [
    { code: 'R1', name: 'Cửa Đỏ', capacity: 6, description: 'Phòng giải đố tối' },
    { code: 'R2', name: 'Hầm Tối', capacity: 8, description: 'Phòng nhóm đông' },
  ];
  for (const room of rooms) {
    const saved = await prisma.room.upsert({
      where: { venueId_code: { venueId: venue.id, code: room.code } },
      update: room,
      create: { venueId: venue.id, ...room },
    });
    await prisma.subGame.upsert({
      where: { venueId_code: { venueId: venue.id, code: room.code } },
      update: { name: room.name, basePrice: 350000, roomId: saved.id },
      create: {
        venueId: venue.id,
        categoryId: escape.id,
        roomId: saved.id,
        name: room.name,
        code: room.code,
        basePrice: 350000,
        tags: 'kinh dị',
      },
    });
  }

  await ensureDefaultMenu(prisma, venue.id);

  await prisma.discountCode.upsert({
    where: { venueId_code: { venueId: venue.id, code: 'HUB10' } },
    update: { percent: 10, active: true },
    create: { venueId: venue.id, code: 'HUB10', percent: 10 },
  });

  await prisma.cmsContent.upsert({
    where: { venueId: venue.id },
    update: {},
    create: {
      venueId: venue.id,
      guide: '1. Chọn phòng và ca còn trống.\n2. Để lại họ tên, email, số điện thoại.\n3. Quầy gọi xác nhận. Giữ chỗ chưa phải thanh toán trên web.\n4. Mỗi khách tự đặt tối đa 2 ca liên tiếp.',
      priceNote: 'Giá theo phòng, chưa gồm đồ uống tại quầy.',
      reviews: 'Minh|Phòng tối, nhân viên gọi xác nhận nhanh.\nLan|Đặt trên web, đến chơi đúng ca.',
    },
  });

  const passwordHash = await hash(seedPassword, 10);
  const admins: { username: string; name: string; roles: AdminRole[]; venueId: string | null }[] = [
    { username: 'sysadmin', name: 'System admin', roles: [AdminRole.system_admin], venueId: null },
    { username: 'editadmin', name: 'Edit admin', roles: [AdminRole.edit_admin], venueId: venue.id },
    { username: 'quay', name: 'Admin quầy', roles: [AdminRole.counter_admin], venueId: venue.id },
  ];
  for (const admin of admins) {
    await prisma.adminUser.upsert({
      where: { username: admin.username },
      update: { name: admin.name, roles: admin.roles, venueId: admin.venueId, active: true, passwordHash },
      create: { ...admin, passwordHash },
    });
  }
}

async function placeCategories() {
  const venues = await prisma.venue.findMany({ orderBy: { code: 'asc' } });
  const loose = await prisma.$queryRaw<{ id: string; kind: GameKind; name: string }[]>`
    SELECT id, kind, name FROM "GameCategory" WHERE "venueId" IS NULL
  `;
  for (const category of loose) {
    const games = await prisma.subGame.findMany({ where: { categoryId: category.id }, select: { venueId: true } });
    const venueIds = [...new Set(games.map((game) => game.venueId))];
    const primary = venueIds[0] || venues.find((item) => item.code === 'DER')?.id || venues[0]?.id;
    if (!primary) continue;
    await prisma.gameCategory.update({ where: { id: category.id }, data: { venueId: primary } });
    for (const venueId of venueIds.filter((id) => id !== primary)) {
      const clone = await prisma.gameCategory.create({
        data: { venueId, billMode: category.kind, name: category.name },
      });
      await prisma.subGame.updateMany({
        where: { venueId, categoryId: category.id },
        data: { categoryId: clone.id },
      });
    }
  }
  for (const item of venues) await ensureDefaultCategories(prisma, item.id);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
