CREATE TYPE "AdminRole" AS ENUM ('system_admin', 'edit_admin', 'counter_admin');
CREATE TYPE "GameKind" AS ENUM ('escape', 'board', 'sat');
CREATE TYPE "BookingStatus" AS ENUM ('pending_confirm', 'confirmed', 'cancelled');
CREATE TYPE "BillType" AS ENUM ('game', 'fnb');
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'transfer');
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'partial', 'paid');
CREATE TYPE "BillLineKind" AS ENUM ('subgame', 'fnb_item', 'extra_manual', 'discount');

CREATE TABLE "Venue" (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "User" (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "AdminUser" (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  role "AdminRole" NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  "venueId" TEXT REFERENCES "Venue"(id),
  "createdById" TEXT
);

CREATE TABLE "GameCategory" (
  id TEXT PRIMARY KEY,
  kind "GameKind" NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE "Room" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 8,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE ("venueId", code)
);

CREATE TABLE "SubGame" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  "categoryId" TEXT NOT NULL REFERENCES "GameCategory"(id),
  "roomId" TEXT REFERENCES "Room"(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  "basePrice" INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE ("venueId", code)
);

CREATE TABLE "TimeSlot" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  "slotIndex" INTEGER NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE ("venueId", "slotIndex")
);

CREATE TABLE "Booking" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  "roomId" TEXT NOT NULL REFERENCES "Room"(id),
  "userId" TEXT REFERENCES "User"(id),
  date TEXT NOT NULL,
  "slotIndex" INTEGER NOT NULL,
  "sessionCode" TEXT,
  "playerCount" INTEGER NOT NULL,
  phone TEXT NOT NULL,
  "guestName" TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status "BookingStatus" NOT NULL DEFAULT 'pending_confirm',
  "createdBy" TEXT NOT NULL DEFAULT 'user',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "DiscountCode" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  code TEXT NOT NULL,
  amount INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE ("venueId", code)
);

CREATE TABLE "Drink" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "Receipt" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  "bookingId" TEXT REFERENCES "Booking"(id),
  phone TEXT NOT NULL,
  "guestName" TEXT NOT NULL DEFAULT '',
  "paymentMethod" "PaymentMethod",
  "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'unpaid',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Bill" (
  id TEXT PRIMARY KEY,
  "receiptId" TEXT NOT NULL REFERENCES "Receipt"(id),
  type "BillType" NOT NULL,
  "categoryKind" "GameKind",
  total INTEGER NOT NULL
);

CREATE TABLE "BillLine" (
  id TEXT PRIMARY KEY,
  "billId" TEXT NOT NULL REFERENCES "Bill"(id),
  kind "BillLineKind" NOT NULL,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL,
  "unitPrice" INTEGER NOT NULL
);

CREATE TABLE "BillPaymentHistory" (
  id TEXT PRIMARY KEY,
  "receiptId" TEXT NOT NULL REFERENCES "Receipt"(id),
  amount INTEGER NOT NULL,
  method "PaymentMethod" NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "staffId" TEXT,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "DayClose" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  date TEXT NOT NULL,
  "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedByAdminId" TEXT NOT NULL,
  UNIQUE ("venueId", date)
);

CREATE TABLE "UserPlayPhoto" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"(id),
  "userId" TEXT REFERENCES "User"(id),
  phone TEXT NOT NULL,
  "billId" TEXT,
  "bookingId" TEXT,
  "fileRef" TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  "uploadedByStaffId" TEXT,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "CmsContent" (
  id TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL UNIQUE REFERENCES "Venue"(id),
  guide TEXT NOT NULL,
  "priceNote" TEXT NOT NULL DEFAULT '',
  reviews TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "ContactMessage" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  content TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
