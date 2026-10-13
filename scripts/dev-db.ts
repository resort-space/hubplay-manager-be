import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: 'pgdata',
    user: 'hubplay',
    password: 'hubplay',
    port: 5432,
    persistent: true,
  });
  if (!existsSync('pgdata')) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('hubplay');
  } catch {
    // database already exists
  }
  execSync('npx prisma db push', { stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
  console.log('Postgres is running on localhost:5432. Leave this process open.');
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
