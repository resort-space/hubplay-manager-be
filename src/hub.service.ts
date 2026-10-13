import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminRole, BillLineKind, BillType, BookingStatus, GameKind, PaymentMethod, Prisma } from '@prisma/client';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from './prisma.service';
import { SessionPayload } from './auth.util';

const otpStore = new Map<string, { code: string; exp: number }>();

@Injectable()
export class HubService {
  constructor(private readonly prisma: PrismaService) {}

  private async venue() {
    const venue = await this.prisma.venue.findFirst({ where: { active: true }, orderBy: { name: 'asc' } });
    if (!venue) throw new NotFoundException('Chưa có cơ sở');
    return venue;
  }

  private assertStaff(session: SessionPayload | null, roles?: AdminRole[]) {
    if (!session || session.kind !== 'admin') throw new ForbiddenException('Cần đăng nhập admin');
    if (roles && session.role && !roles.includes(session.role)) throw new ForbiddenException('Không đủ quyền');
    return session;
  }

  async requestOtp(phone: string) {
    const code = process.env.OTP_DEV === 'true' ? '000000' : String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(phone, { code, exp: Date.now() + 5 * 60 * 1000 });
    return { ok: true, devCode: process.env.OTP_DEV === 'true' ? code : undefined };
  }

  async verifyOtp(phone: string, code: string, name?: string, email?: string) {
    const row = otpStore.get(phone);
    if (!row || row.exp < Date.now() || row.code !== code) throw new BadRequestException('OTP không đúng');
    otpStore.delete(phone);
    const user = await this.prisma.user.upsert({
      where: { phone },
      update: { name: name || undefined, email: email || undefined },
      create: { phone, name: name || '', email: email || '' },
    });
    return user;
  }

  async publicHome() {
    const venue = await this.venue();
    const [rooms, slots, drinks, discounts, cms, subGames] = await Promise.all([
      this.prisma.room.findMany({ where: { venueId: venue.id, active: true }, orderBy: { code: 'asc' } }),
      this.prisma.timeSlot.findMany({ where: { venueId: venue.id, enabled: true }, orderBy: { slotIndex: 'asc' } }),
      this.prisma.drink.findMany({ where: { venueId: venue.id, active: true }, orderBy: { name: 'asc' } }),
      this.prisma.discountCode.findMany({ where: { venueId: venue.id, active: true } }),
      this.prisma.cmsContent.findUnique({ where: { venueId: venue.id } }),
      this.prisma.subGame.findMany({
        where: { venueId: venue.id, active: true },
        include: { category: true, room: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { venue, rooms, slots, drinks, discounts, cms, subGames };
  }

  async slotsFor(roomId: string, date: string) {
    const venue = await this.venue();
    const slots = await this.prisma.timeSlot.findMany({
      where: { venueId: venue.id, enabled: true },
      orderBy: { slotIndex: 'asc' },
    });
    const taken = await this.prisma.booking.findMany({
      where: {
        venueId: venue.id,
        roomId,
        date,
        status: { in: [BookingStatus.pending_confirm, BookingStatus.confirmed] },
      },
    });
    const takenSet = new Set(taken.map((b) => b.slotIndex));
    return slots.map((s) => ({ ...s, reserved: takenSet.has(s.slotIndex) }));
  }

  async weekBookings(from: string, to: string, session: SessionPayload | null) {
    const venue = await this.venue();
    const rows = await this.prisma.booking.findMany({
      where: {
        venueId: venue.id,
        date: { gte: from, lte: to },
        status: { not: BookingStatus.cancelled },
      },
      include: { room: true },
      orderBy: [{ date: 'asc' }, { slotIndex: 'asc' }],
    });
    if (session?.kind === 'admin') return rows;
    return rows.map(({ phone, guestName, email, ...rest }) => ({ ...rest, phone: '', guestName: '', email: '' }));
  }

  private assertConsecutive(indexes: number[]) {
    const sorted = [...indexes].sort((a, b) => a - b);
    if (sorted.length < 1 || sorted.length > 2) throw new BadRequestException('Chỉ đặt tối đa 2 ca liên tiếp');
    if (sorted.length === 2 && sorted[1] - sorted[0] !== 1) {
      throw new BadRequestException('Hai ca phải liền nhau');
    }
    return sorted;
  }

  async createBooking(input: {
    roomId: string;
    date: string;
    slotIndexes: number[];
    guestName: string;
    email: string;
    phone: string;
    playerCount: number;
    note?: string;
    userId?: string;
  }) {
    const venue = await this.venue();
    const slots = this.assertConsecutive(input.slotIndexes);
    const room = await this.prisma.room.findFirst({ where: { id: input.roomId, venueId: venue.id, active: true } });
    if (!room) throw new NotFoundException('Không thấy phòng');
    if (input.playerCount < 1 || input.playerCount > room.capacity) {
      throw new BadRequestException(`Số người từ 1 đến ${room.capacity}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const clash = await tx.booking.findFirst({
        where: {
          venueId: venue.id,
          roomId: room.id,
          date: input.date,
          slotIndex: { in: slots },
          status: { in: [BookingStatus.pending_confirm, BookingStatus.confirmed] },
        },
      });
      if (clash) throw new BadRequestException('Ca đã có người giữ');
      const created = [];
      for (const slotIndex of slots) {
        created.push(
          await tx.booking.create({
            data: {
              venueId: venue.id,
              roomId: room.id,
              userId: input.userId,
              date: input.date,
              slotIndex,
              playerCount: input.playerCount,
              phone: input.phone,
              guestName: input.guestName,
              email: input.email,
              note: input.note || '',
              status: BookingStatus.pending_confirm,
              createdBy: 'user',
            },
            include: { room: true },
          }),
        );
      }
      return created;
    });
  }

  async confirmBooking(id: string, session: SessionPayload | null) {
    this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const booking = await this.prisma.booking.findUnique({ where: { id }, include: { room: true } });
    if (!booking || booking.status !== BookingStatus.pending_confirm) throw new BadRequestException('Không thể giữ ca này');
    const count = await this.prisma.booking.count({
      where: { roomId: booking.roomId, date: booking.date, slotIndex: booking.slotIndex, sessionCode: { not: null } },
    });
    const ymd = booking.date.replace(/-/g, '');
    const sessionCode = `${booking.room.code}${ymd}${String(booking.slotIndex).padStart(2, '0')}${count + 1}`;
    return this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.confirmed, sessionCode },
      include: { room: true },
    });
  }

  async cancelBooking(id: string, session: SessionPayload | null) {
    this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    if (!booking || booking.status === BookingStatus.cancelled) throw new BadRequestException('Ca không còn để hủy');
    return this.prisma.booking.update({ where: { id }, data: { status: BookingStatus.cancelled } });
  }

  async updateSlot(id: string, startTime: string, endTime: string, enabled: boolean, session: SessionPayload | null) {
    this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    return this.prisma.timeSlot.update({ where: { id }, data: { startTime, endTime, enabled } });
  }

  async saveRoom(session: SessionPayload | null, data: { id?: string; name: string; code: string; capacity: number; description?: string; active?: boolean }) {
    this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.venue();
    if (data.id) {
      return this.prisma.room.update({
        where: { id: data.id },
        data: { name: data.name, code: data.code, capacity: data.capacity, description: data.description ?? '', active: data.active ?? true },
      });
    }
    return this.prisma.room.create({
      data: { venueId: venue.id, name: data.name, code: data.code, capacity: data.capacity, description: data.description ?? '' },
    });
  }

  async saveSubGame(session: SessionPayload | null, data: { id?: string; name: string; code: string; basePrice: number; kind: GameKind; roomId?: string; tags?: string; active?: boolean }) {
    this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.venue();
    const category = await this.prisma.gameCategory.findUnique({ where: { kind: data.kind } });
    if (!category) throw new BadRequestException('Loại game không hợp lệ');
    if (data.id) {
      return this.prisma.subGame.update({
        where: { id: data.id },
        data: { name: data.name, code: data.code, basePrice: data.basePrice, categoryId: category.id, roomId: data.roomId || null, tags: data.tags ?? '', active: data.active ?? true },
      });
    }
    return this.prisma.subGame.create({
      data: {
        venueId: venue.id,
        categoryId: category.id,
        roomId: data.roomId || null,
        name: data.name,
        code: data.code,
        basePrice: data.basePrice,
        tags: data.tags ?? '',
      },
    });
  }

  async saveDrink(session: SessionPayload | null, data: { id?: string; name: string; price: number; active?: boolean }) {
    this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.venue();
    if (data.id) return this.prisma.drink.update({ where: { id: data.id }, data: { name: data.name, price: data.price, active: data.active ?? true } });
    return this.prisma.drink.create({ data: { venueId: venue.id, name: data.name, price: data.price } });
  }

  async saveCms(session: SessionPayload | null, guide: string, priceNote: string, reviews: string) {
    this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.venue();
    return this.prisma.cmsContent.upsert({
      where: { venueId: venue.id },
      update: { guide, priceNote, reviews },
      create: { venueId: venue.id, guide, priceNote, reviews },
    });
  }

  async createAdmin(session: SessionPayload | null, username: string, passwordHash: string, role: AdminRole) {
    this.assertStaff(session, [AdminRole.system_admin]);
    if (role === AdminRole.system_admin) throw new BadRequestException('Không gán role system-admin');
    const venue = await this.venue();
    return this.prisma.adminUser.create({
      data: { username, passwordHash, role, venueId: venue.id, createdById: session!.sub },
      select: { id: true, username: true, role: true, active: true },
    });
  }

  async listAdmins(session: SessionPayload | null) {
    this.assertStaff(session, [AdminRole.system_admin]);
    return this.prisma.adminUser.findMany({
      where: { role: { not: AdminRole.system_admin } },
      select: { id: true, username: true, role: true, active: true },
      orderBy: { username: 'asc' },
    });
  }

  async createReceipt(
    session: SessionPayload | null,
    input: {
      phone: string;
      guestName?: string;
      bookingId?: string;
      paymentMethod: PaymentMethod;
      lines: { kind: BillLineKind; description: string; qty: number; unitPrice: number; ledger: 'game' | 'fnb'; categoryKind?: GameKind }[];
    },
  ) {
    this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const venue = await this.venue();
    if (!input.lines.length) throw new BadRequestException('Phiếu chưa có dòng');
    const gameLines = input.lines.filter((l) => l.ledger === 'game');
    const fnbLines = input.lines.filter((l) => l.ledger === 'fnb');
    const sum = (rows: typeof input.lines) => rows.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const total = sum(input.lines);
    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          venueId: venue.id,
          bookingId: input.bookingId || null,
          phone: input.phone,
          guestName: input.guestName || '',
          paymentMethod: input.paymentMethod,
          paymentStatus: 'paid',
        },
      });
      const makeBill = async (type: BillType, rows: typeof input.lines) => {
        if (!rows.length) return;
        const bill = await tx.bill.create({
          data: {
            receiptId: receipt.id,
            type,
            categoryKind: rows.find((r) => r.categoryKind)?.categoryKind,
            total: sum(rows),
          },
        });
        await tx.billLine.createMany({
          data: rows.map((r) => ({
            billId: bill.id,
            kind: r.kind,
            description: r.description,
            qty: r.qty,
            unitPrice: r.unitPrice,
          })),
        });
      };
      await makeBill(BillType.game, gameLines);
      await makeBill(BillType.fnb, fnbLines);
      await tx.billPaymentHistory.create({
        data: { receiptId: receipt.id, amount: total, method: input.paymentMethod, staffId: session!.sub },
      });
      return this.receiptDetail(receipt.id, tx);
    });
  }

  private receiptDetail(id: string, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    return tx.receipt.findUnique({
      where: { id },
      include: { bills: { include: { lines: true } }, payments: true, booking: { include: { room: true } }, venue: true },
    });
  }

  async listReceipts(session: SessionPayload | null, date?: string) {
    this.assertStaff(session);
    const venue = await this.venue();
    return this.prisma.receipt.findMany({
      where: {
        venueId: venue.id,
        ...(date ? { createdAt: { gte: new Date(`${date}T00:00:00+07:00`), lt: new Date(`${date}T23:59:59+07:00`) } } : {}),
      },
      include: { bills: { include: { lines: true } }, payments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async dayRevenue(session: SessionPayload | null, date: string) {
    this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.venue();
    const receipts = await this.prisma.receipt.findMany({
      where: {
        venueId: venue.id,
        paymentStatus: 'paid',
        createdAt: { gte: new Date(`${date}T00:00:00+07:00`), lt: new Date(new Date(`${date}T00:00:00+07:00`).getTime() + 86400000) },
      },
      include: { bills: true, payments: true },
    });
    const closed = await this.prisma.dayClose.findUnique({ where: { venueId_date: { venueId: venue.id, date } } });
    let game = 0;
    let fnb = 0;
    let cash = 0;
    let transfer = 0;
    for (const r of receipts) {
      for (const b of r.bills) {
        if (b.type === 'game') game += b.total;
        else fnb += b.total;
      }
      for (const p of r.payments) {
        if (p.method === 'cash') cash += p.amount;
        else transfer += p.amount;
      }
    }
    return { date, game, fnb, cash, transfer, total: game + fnb, closed: Boolean(closed) };
  }

  async closeDay(session: SessionPayload | null, date: string) {
    this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.venue();
    const existing = await this.prisma.dayClose.findUnique({ where: { venueId_date: { venueId: venue.id, date } } });
    if (existing) throw new BadRequestException('Ngày đã chốt');
    await this.prisma.dayClose.create({ data: { venueId: venue.id, date, closedByAdminId: session!.sub } });
    return this.dayRevenue(session, date);
  }

  async summary(session: SessionPayload | null, year: number, period: string) {
    this.assertStaff(session, [AdminRole.system_admin]);
    const venue = await this.venue();
    const closes = await this.prisma.dayClose.findMany({ where: { venueId: venue.id, date: { startsWith: String(year) } } });
    const dates = closes.map((c) => c.date).filter((d) => matchPeriod(d, year, period));
    const receipts = await this.prisma.receipt.findMany({
      where: { venueId: venue.id, paymentStatus: 'paid' },
      include: { bills: true },
    });
    const buckets = { escape: 0, board: 0, sat: 0, fnb: 0, game: 0 };
    for (const r of receipts) {
      const day = toVnDate(r.createdAt);
      if (!dates.includes(day)) continue;
      for (const b of r.bills) {
        if (b.type === 'fnb') buckets.fnb += b.total;
        else {
          buckets.game += b.total;
          if (b.categoryKind === 'escape') buckets.escape += b.total;
          if (b.categoryKind === 'board') buckets.board += b.total;
          if (b.categoryKind === 'sat') buckets.sat += b.total;
        }
      }
    }
    return { year, period, closedDays: dates.length, ...buckets };
  }

  async savePhoto(session: SessionPayload | null, phone: string, file: Express.Multer.File, bookingId?: string, billId?: string, caption?: string) {
    this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const venue = await this.venue();
    const user = await this.prisma.user.findUnique({ where: { phone } });
    const dir = join(process.cwd(), 'uploads');
    await mkdir(dir, { recursive: true });
    const filename = `${Date.now()}-${file.originalname.replace(/[^\w.\-]+/g, '_')}`;
    await writeFile(join(dir, filename), file.buffer);
    return this.prisma.userPlayPhoto.create({
      data: {
        venueId: venue.id,
        userId: user?.id,
        phone,
        bookingId,
        billId,
        fileRef: filename,
        caption: caption || '',
        uploadedByStaffId: session!.sub,
      },
    });
  }

  async myData(session: SessionPayload | null) {
    if (!session || session.kind !== 'user' || !session.phone) throw new ForbiddenException('Cần đăng nhập');
    const phone = session.phone;
    const [bookings, receipts, photos] = await Promise.all([
      this.prisma.booking.findMany({ where: { phone }, include: { room: true, venue: true }, orderBy: { date: 'desc' } }),
      this.prisma.receipt.findMany({
        where: { phone },
        include: { bills: { include: { lines: true } }, payments: true, venue: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.userPlayPhoto.findMany({ where: { phone }, orderBy: { uploadedAt: 'desc' } }),
    ]);
    return { bookings, receipts, photos };
  }

  async contact(name: string, phone: string, content: string) {
    return this.prisma.contactMessage.create({ data: { name, phone, content } });
  }
}

function toVnDate(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function matchPeriod(date: string, year: number, period: string) {
  if (!date.startsWith(String(year))) return false;
  if (period === 'year' || period === String(year)) return true;
  if (/^Q[1-4]$/.test(period)) {
    const month = Number(date.slice(5, 7));
    const q = Math.ceil(month / 3);
    return period === `Q${q}`;
  }
  if (/^\d{2}$/.test(period)) return date.slice(5, 7) === period;
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return date === period;
  return false;
}
