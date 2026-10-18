import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import { syncDefaultSatGames } from '../src/categories';
import { syncDefaultMenuPrices } from '../src/menu';

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

async function main() {
  loadEnvFile();
  const prisma = new PrismaClient();
  try {
    const venues = await prisma.venue.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } });
    if (!venues.length) {
      console.log('Chưa có cơ sở.');
      return;
    }
    const skipped = new Set<string>();
    for (const venue of venues) {
      const games = await syncDefaultSatGames(prisma, venue.id);
      const menu = await syncDefaultMenuPrices(prisma, venue.id);
      for (const name of menu.skipped) skipped.add(name);
      console.log(`${venue.code}: ${games} kịch bản, ${menu.updated} món`);
    }
    if (skipped.size) {
      console.log(`Giữ nguyên giá vì danh mục gốc có nhiều giá cho: ${[...skipped].join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
