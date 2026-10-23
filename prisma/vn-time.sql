-- Chạy trên database production khi SHOW timezone còn là UTC.
-- Đừng db push trước các ALTER TABLE này nếu timezone đã là Asia/Ho_Chi_Minh.

ALTER TABLE "Booking"
  ALTER COLUMN "createdAt" TYPE timestamptz(3)
  USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "Receipt"
  ALTER COLUMN "createdAt" TYPE timestamptz(3)
  USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "BillPaymentHistory"
  ALTER COLUMN "paidAt" TYPE timestamptz(3)
  USING "paidAt" AT TIME ZONE 'UTC';

ALTER TABLE "DayClose"
  ALTER COLUMN "closedAt" TYPE timestamptz(3)
  USING "closedAt" AT TIME ZONE 'UTC';

ALTER TABLE "UserPlayPhoto"
  ALTER COLUMN "uploadedAt" TYPE timestamptz(3)
  USING "uploadedAt" AT TIME ZONE 'UTC';

ALTER TABLE "ContactMessage"
  ALTER COLUMN "createdAt" TYPE timestamptz(3)
  USING "createdAt" AT TIME ZONE 'UTC';

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''Asia/Ho_Chi_Minh''', current_database());
END $$;
