ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "roles" "AdminRole"[];
UPDATE "AdminUser"
SET "roles" = ARRAY["role"]
WHERE "role" IS NOT NULL AND ("roles" IS NULL OR cardinality("roles") = 0);
ALTER TABLE "AdminUser" ALTER COLUMN "roles" SET NOT NULL;
ALTER TABLE "AdminUser" DROP COLUMN IF EXISTS "role";
