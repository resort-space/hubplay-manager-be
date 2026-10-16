import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { AdminRole, BillLineKind, BillType, BookingStatus, GameKind, PaymentMethod, PricingUnit, Prisma } from '@prisma/client';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from './prisma.service';
import { SessionPayload } from './auth.util';
import { ensureDefaultCategories, ensureEscapeCategory } from './categories';

const otpStore = new Map<string, { code: string; exp: number }>();

const defaultSlots = [
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

@Injectable()
export class HubService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const venues = await this.prisma.venue.findMany({ select: { id: true } });
    for (const venue of venues) await ensureDefaultCategories(this.prisma, venue.id);
  }

  private async staffVenueId(session: SessionPayload) {
    if (session.role === AdminRole.system_admin) return null;
    const admin = await this.prisma.adminUser.findUnique({ where: { id: session.sub }, select: { venueId: true, active: true } });
    if (!admin?.active || !admin.venueId) throw new ForbiddenException('Tài khoản chưa gắn cơ sở');
    return admin.venueId;
  }

  private async resolveVenue(session: SessionPayload | null, venueId?: string | null) {
    const requested = venueId?.trim() || undefined;
    if (session?.kind === 'admin' && session.role !== AdminRole.system_admin) {
      const own = await this.staffVenueId(session);
      if (requested && requested !== own) throw new ForbiddenException('Không đúng cơ sở');
      const venue = await this.prisma.venue.findFirst({ where: { id: own!, active: true } });
      if (!venue) throw new NotFoundException('Cơ sở không hoạt động');
      return venue;
    }
    if (requested) {
      const venue = await this.prisma.venue.findUnique({ where: { id: requested } });
      if (!venue) throw new NotFoundException('Không thấy cơ sở');
      const isSystem = session?.kind === 'admin' && session.role === AdminRole.system_admin;
      if (!venue.active && !isSystem) throw new NotFoundException('Không thấy cơ sở');
      return venue;
    }
    const active = await this.prisma.venue.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    if (active.length === 1) return active[0];
    if (!active.length) throw new NotFoundException('Chưa có cơ sở');
    throw new BadRequestException('Chọn cơ sở');
  }

  private async assertRecordVenue(session: SessionPayload, recordVenueId: string) {
    const own = await this.staffVenueId(session);
    if (own && own !== recordVenueId) throw new ForbiddenException('Không đúng cơ sở');
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

  async listVenues(session: SessionPayload | null) {
    if (session?.kind === 'admin' && session.role === AdminRole.system_admin) {
      return this.prisma.venue.findMany({ orderBy: { name: 'asc' } });
    }
    return this.prisma.venue.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  }

  async createVenue(session: SessionPayload | null, data: { code: string; name: string; address: string; phone?: string }) {
    this.assertStaff(session, [AdminRole.system_admin]);
    const code = data.code?.trim();
    const name = data.name?.trim();
    const address = data.address?.trim();
    if (!code || !name || !address) throw new BadRequestException('Thiếu tên, mã hoặc địa chỉ');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const venue = await tx.venue.create({ data: { code, name, address, phone: data.phone?.trim() || '' } });
        await tx.timeSlot.createMany({
          data: defaultSlots.map(([slotIndex, startTime, endTime]) => ({ venueId: venue.id, slotIndex, startTime, endTime })),
        });
        await tx.cmsContent.create({ data: { venueId: venue.id, guide: '', priceNote: '', reviews: '' } });
        await ensureDefaultCategories(tx, venue.id);
        return venue;
      });
    } catch (error) {
      if (isUnique(error)) throw new BadRequestException('Mã cơ sở đã có');
      throw error;
    }
  }

  async updateVenue(session: SessionPayload | null, id: string, data: { code?: string; name?: string; address?: string; phone?: string; active?: boolean }) {
    this.assertStaff(session, [AdminRole.system_admin]);
    const existing = await this.prisma.venue.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Không thấy cơ sở');
    const code = data.code !== undefined ? data.code.trim() : undefined;
    const name = data.name !== undefined ? data.name.trim() : undefined;
    const address = data.address !== undefined ? data.address.trim() : undefined;
    if (code === '' || name === '' || address === '') throw new BadRequestException('Thiếu tên, mã hoặc địa chỉ');
    try {
      return await this.prisma.venue.update({
        where: { id },
        data: {
          ...(code !== undefined ? { code } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(address !== undefined ? { address } : {}),
          ...(data.phone !== undefined ? { phone: data.phone.trim() } : {}),
          ...(data.active !== undefined ? { active: Boolean(data.active) } : {}),
        },
      });
    } catch (error) {
      if (isUnique(error)) throw new BadRequestException('Mã cơ sở đã có');
      throw error;
    }
  }

  async deleteVenue(session: SessionPayload | null, id: string) {
    this.assertStaff(session, [AdminRole.system_admin]);
    const existing = await this.prisma.venue.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Không thấy cơ sở');
    const total = await this.prisma.venue.count();
    if (total <= 1) throw new BadRequestException('Phải giữ ít nhất một cơ sở');
    const [bookings, receipts, closes, photos, admins] = await Promise.all([
      this.prisma.booking.count({ where: { venueId: id } }),
      this.prisma.receipt.count({ where: { venueId: id } }),
      this.prisma.dayClose.count({ where: { venueId: id } }),
      this.prisma.userPlayPhoto.count({ where: { venueId: id } }),
      this.prisma.adminUser.count({ where: { venueId: id } }),
    ]);
    if (bookings || receipts || closes || photos) throw new BadRequestException('Cơ sở đã có lịch sử, không xóa được');
    if (admins) throw new BadRequestException('Còn tài khoản gắn cơ sở này');
    await this.prisma.$transaction(async (tx) => {
      await tx.subGame.deleteMany({ where: { venueId: id } });
      await tx.gameCategory.deleteMany({ where: { venueId: id } });
      await tx.room.deleteMany({ where: { venueId: id } });
      await tx.drink.deleteMany({ where: { venueId: id } });
      await tx.discountCode.deleteMany({ where: { venueId: id } });
      await tx.timeSlot.deleteMany({ where: { venueId: id } });
      await tx.cmsContent.deleteMany({ where: { venueId: id } });
      await tx.venue.delete({ where: { id } });
    });
    return { ok: true };
  }

  async publicHome(session: SessionPayload | null, venueId?: string) {
    const venue = await this.resolveVenue(session, venueId);
    const [rooms, slots, drinks, discounts, cms, subGames, categories] = await Promise.all([
      this.prisma.room.findMany({ where: { venueId: venue.id, active: true }, orderBy: { code: 'asc' } }),
      this.prisma.timeSlot.findMany({ where: { venueId: venue.id, enabled: true }, orderBy: { slotIndex: 'asc' } }),
      this.prisma.drink.findMany({ where: { venueId: venue.id, active: true }, orderBy: { name: 'asc' } }),
      this.prisma.discountCode.findMany({ where: { venueId: venue.id, active: true }, orderBy: { code: 'asc' } }),
      this.prisma.cmsContent.findUnique({ where: { venueId: venue.id } }),
      this.prisma.subGame.findMany({
        where: { venueId: venue.id, active: true },
        include: { category: true, room: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.gameCategory.findMany({
        where: { venueId: venue.id },
        select: { id: true, name: true, billMode: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { venue, rooms, slots, drinks, discounts, cms, subGames, categories };
  }

  async slotsFor(roomId: string, date: string, session: SessionPayload | null, venueId?: string) {
    const venue = await this.resolveVenue(session, venueId);
    const room = await this.prisma.room.findFirst({ where: { id: roomId, venueId: venue.id } });
    if (!room) throw new NotFoundException('Không thấy game');
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

  async weekBookings(from: string, to: string, session: SessionPayload | null, venueId?: string) {
    const venue = await this.resolveVenue(session, venueId);
    const rows = await this.prisma.booking.findMany({
      where: {
        venueId: venue.id,
        date: { gte: from, lte: to },
        status: { not: BookingStatus.cancelled },
      },
      include: { room: true, _count: { select: { receipts: true } } },
      orderBy: [{ date: 'asc' }, { slotIndex: 'asc' }],
    });
    return rows.map(({ _count, phone, guestName, email, ...rest }) => {
      const paid = _count.receipts > 0;
      if (session?.kind === 'admin') return { ...rest, phone, guestName, email, paid };
      return { ...rest, phone: '', guestName: '', email: '', paid: false };
    });
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
    venueId?: string;
  }, session: SessionPayload | null) {
    const venue = await this.resolveVenue(session?.kind === 'admin' ? session : null, input.venueId);
    const slots = this.assertConsecutive(input.slotIndexes);
    const room = await this.prisma.room.findFirst({ where: { id: input.roomId, venueId: venue.id, active: true } });
    if (!room) throw new NotFoundException('Không thấy game');
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
    await this.assertRecordVenue(session!, booking.venueId);
    return this.holdBooking(this.prisma, booking);
  }

  private holdBooking(
    db: Prisma.TransactionClient | PrismaService,
    booking: { id: string; roomId: string; date: string; slotIndex: number; room: { code: string } },
  ) {
    return db.booking.count({
      where: { roomId: booking.roomId, date: booking.date, slotIndex: booking.slotIndex, sessionCode: { not: null } },
    }).then((count) => {
      const ymd = booking.date.replace(/-/g, '');
      const sessionCode = `${booking.room.code}${ymd}${String(booking.slotIndex).padStart(2, '0')}${count + 1}`;
      return db.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.confirmed, sessionCode },
        include: { room: true },
      });
    });
  }

  async cancelBooking(id: string, session: SessionPayload | null) {
    this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const booking = await this.prisma.booking.findUnique({ where: { id }, include: { _count: { select: { receipts: true } } } });
    if (!booking || booking.status === BookingStatus.cancelled) throw new BadRequestException('Ca không còn để hủy');
    if (booking._count.receipts > 0) throw new BadRequestException('Ca đã thanh toán, không hủy được');
    await this.assertRecordVenue(session!, booking.venueId);
    return this.prisma.booking.update({ where: { id }, data: { status: BookingStatus.cancelled } });
  }

  async updateBooking(
    id: string,
    input: { guestName: string; phone: string; email: string; playerCount: number },
    session: SessionPayload | null,
  ) {
    this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const booking = await this.prisma.booking.findUnique({ where: { id }, include: { room: true, _count: { select: { receipts: true } } } });
    if (!booking || booking.status === BookingStatus.cancelled) throw new BadRequestException('Ca không còn để sửa');
    if (booking._count.receipts > 0) throw new BadRequestException('Ca đã thanh toán, không sửa được');
    await this.assertRecordVenue(session!, booking.venueId);
    const guestName = input.guestName.trim();
    const phone = input.phone.trim();
    if (!guestName) throw new BadRequestException('Nhập tên khách');
    if (!phone) throw new BadRequestException('Nhập SĐT');
    if (input.playerCount < 1 || input.playerCount > booking.room.capacity) {
      throw new BadRequestException(`Số người từ 1 đến ${booking.room.capacity}`);
    }
    return this.prisma.booking.update({
      where: { id },
      data: { guestName, phone, email: input.email.trim(), playerCount: input.playerCount },
      include: { room: true },
    });
  }

  async updateSlot(id: string, startTime: string, endTime: string, enabled: boolean, session: SessionPayload | null) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const slot = await this.prisma.timeSlot.findUnique({ where: { id } });
    if (!slot) throw new NotFoundException('Không thấy ca');
    await this.assertRecordVenue(staff, slot.venueId);
    return this.prisma.timeSlot.update({ where: { id }, data: { startTime, endTime, enabled } });
  }

  async saveRoom(session: SessionPayload | null, data: { id?: string; name: string; code: string; capacity: number; description?: string; active?: boolean; venueId?: string }) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, data.venueId);
    await this.assertCodeFree(venue.id, data.code, { roomId: data.id });
    try {
      if (data.id) {
        const room = await this.prisma.room.findUnique({ where: { id: data.id } });
        if (!room || room.venueId !== venue.id) throw new ForbiddenException('Không đúng cơ sở');
        return await this.prisma.room.update({
          where: { id: data.id },
          data: { name: data.name, code: data.code, capacity: data.capacity, description: data.description ?? '', active: data.active ?? true },
        });
      }
      return await this.prisma.room.create({
        data: { venueId: venue.id, name: data.name, code: data.code, capacity: data.capacity, description: data.description ?? '' },
      });
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      if (isUnique(error)) throw new BadRequestException('Mã đã có');
      throw error;
    }
  }

  async deleteRoom(session: SessionPayload | null, id: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room || room.venueId !== venue.id) throw new NotFoundException('Không thấy game');
    const bookings = await this.prisma.booking.count({ where: { roomId: id } });
    if (bookings) throw new BadRequestException('Game đã có lịch đặt, không xóa được');
    const linked = await this.prisma.subGame.findMany({ where: { roomId: id }, select: { id: true } });
    const used = await this.prisma.billLine.count({ where: { subGameId: { in: linked.map((game) => game.id) } } });
    if (used) throw new BadRequestException('Game đã có bill, không xóa được');
    await this.prisma.$transaction(async (tx) => {
      await tx.subGame.deleteMany({ where: { roomId: id } });
      await tx.room.delete({ where: { id } });
    });
    return { ok: true };
  }

  private async assertCodeFree(venueId: string, code: string, except?: { roomId?: string; subGameId?: string }) {
    const trimmed = code?.trim();
    if (!trimmed) throw new BadRequestException('Nhập mã');
    const room = await this.prisma.room.findFirst({ where: { venueId, code: trimmed } });
    if (room && room.id !== except?.roomId) throw new BadRequestException('Mã đã có');
    const game = await this.prisma.subGame.findFirst({ where: { venueId, code: trimmed } });
    if (game && game.id !== except?.subGameId && game.roomId !== except?.roomId) throw new BadRequestException('Mã đã có');
  }

  async saveSubGame(session: SessionPayload | null, data: { id?: string; name: string; code: string; basePrice: number; kind?: GameKind; categoryId?: string; pricingUnit?: PricingUnit; roomId?: string; tags?: string; active?: boolean; venueId?: string }) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, data.venueId);
    const name = data.name?.trim();
    const code = data.code?.trim();
    if (!name || !code) throw new BadRequestException('Nhập tên và mã');
    const existing = data.id ? await this.prisma.subGame.findUnique({ where: { id: data.id } }) : null;
    if (data.id && (!existing || existing.venueId !== venue.id)) throw new ForbiddenException('Không đúng cơ sở');
    let category = data.categoryId
      ? await this.prisma.gameCategory.findUnique({ where: { id: data.categoryId } })
      : data.kind
        ? await this.prisma.gameCategory.findFirst({ where: { venueId: venue.id, billMode: data.kind }, orderBy: { id: 'asc' } })
        : null;
    if (!category && data.kind === GameKind.escape) category = await ensureEscapeCategory(this.prisma, venue.id);
    if (!category || category.venueId !== venue.id) throw new BadRequestException('Chọn phòng');
    if (!existing && category.billMode === GameKind.escape && !data.roomId) throw new BadRequestException('Game đặt lịch thêm trong phòng Doors Escape');
    const roomId = data.roomId || existing?.roomId || null;
    await this.assertCodeFree(venue.id, code, { roomId: roomId || undefined, subGameId: existing?.id });
    const pricingUnit = PricingUnit.per_session;
    try {
      if (existing) {
        return await this.prisma.subGame.update({
          where: { id: existing.id },
          data: { name, code, basePrice: data.basePrice, categoryId: category.id, pricingUnit, roomId, tags: data.tags ?? existing.tags, active: data.active ?? existing.active },
        });
      }
      return await this.prisma.subGame.create({
        data: { venueId: venue.id, categoryId: category.id, roomId, name, code, basePrice: data.basePrice, pricingUnit, tags: data.tags ?? '' },
      });
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof BadRequestException) throw error;
      if (isUnique(error)) throw new BadRequestException('Mã đã có');
      throw error;
    }
  }

  async deleteSubGame(session: SessionPayload | null, id: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    const game = await this.prisma.subGame.findUnique({ where: { id } });
    if (!game || game.venueId !== venue.id) throw new NotFoundException('Không thấy game');
    if (game.roomId) throw new BadRequestException('Xóa game đặt lịch trong phòng Doors Escape');
    const used = await this.prisma.billLine.count({ where: { subGameId: id } });
    if (used) throw new BadRequestException('Game đã có bill, không xóa được');
    await this.prisma.subGame.delete({ where: { id } });
    return { ok: true };
  }

  async listCategories(session: SessionPayload | null, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    return this.prisma.gameCategory.findMany({
      where: { venueId: venue.id },
      include: { subGames: { include: { category: true, room: true }, orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  async saveCategory(session: SessionPayload | null, data: { name: string; billMode: GameKind; venueId?: string }) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, data.venueId);
    const name = data.name?.trim();
    if (!name) throw new BadRequestException('Nhập tên phòng');
    if (data.billMode !== GameKind.board) throw new BadRequestException('Phòng thêm không đặt lịch');
    try {
      return await this.prisma.gameCategory.create({ data: { venueId: venue.id, name, billMode: data.billMode } });
    } catch (error) {
      if (isUnique(error)) throw new BadRequestException('Tên phòng đã có');
      throw error;
    }
  }

  async renameCategory(session: SessionPayload | null, id: string, name: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    const category = await this.prisma.gameCategory.findUnique({ where: { id } });
    if (!category || category.venueId !== venue.id) throw new NotFoundException('Không thấy phòng');
    const next = name?.trim();
    if (!next) throw new BadRequestException('Nhập tên phòng');
    try {
      return await this.prisma.gameCategory.update({ where: { id }, data: { name: next } });
    } catch (error) {
      if (isUnique(error)) throw new BadRequestException('Tên phòng đã có');
      throw error;
    }
  }

  async deleteCategory(session: SessionPayload | null, id: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    const category = await this.prisma.gameCategory.findUnique({ where: { id }, include: { subGames: { select: { id: true } } } });
    if (!category || category.venueId !== venue.id) throw new NotFoundException('Không thấy phòng');
    const childIds = category.subGames.map((game) => game.id);
    const [bills, lineRefs, oldest] = await Promise.all([
      this.prisma.bill.count({ where: { categoryId: id } }),
      this.prisma.billLine.count({ where: { subGameId: { in: childIds } } }),
      this.prisma.gameCategory.findFirst({ where: { venueId: venue.id, billMode: category.billMode }, orderBy: { id: 'asc' }, select: { id: true } }),
    ]);
    const legacy = oldest?.id === id
      ? await this.prisma.bill.count({ where: { categoryId: null, categoryKind: category.billMode, receipt: { venueId: venue.id } } })
      : 0;
    if (bills || lineRefs || legacy) throw new BadRequestException('Phòng đã có bill, không xóa được');
    if (category.billMode === GameKind.escape) {
      const [rooms, bookings] = await Promise.all([
        this.prisma.room.count({ where: { venueId: venue.id } }),
        this.prisma.booking.count({ where: { venueId: venue.id } }),
      ]);
      if (rooms || bookings) throw new BadRequestException('Còn game đang đặt hoặc còn lịch, không xóa phòng này');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subGame.deleteMany({ where: { categoryId: id } });
      await tx.gameCategory.delete({ where: { id } });
    });
    return { ok: true };
  }

  async saveDrink(session: SessionPayload | null, data: { id?: string; name: string; price: number; active?: boolean; venueId?: string }) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, data.venueId);
    if (data.id) {
      const drink = await this.prisma.drink.findUnique({ where: { id: data.id } });
      if (!drink || drink.venueId !== venue.id) throw new ForbiddenException('Không đúng cơ sở');
      return this.prisma.drink.update({ where: { id: data.id }, data: { name: data.name, price: data.price, active: data.active ?? true } });
    }
    return this.prisma.drink.create({ data: { venueId: venue.id, name: data.name, price: data.price } });
  }

  async listDiscounts(session: SessionPayload | null, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    return this.prisma.discountCode.findMany({ where: { venueId: venue.id }, orderBy: { code: 'asc' } });
  }

  async saveDiscount(session: SessionPayload | null, data: { id?: string; code: string; amount: number; venueId?: string }) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, data.venueId);
    const code = data.code?.trim().toUpperCase();
    const amount = Number(data.amount);
    if (!code) throw new BadRequestException('Nhập mã');
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Số tiền giảm phải lớn hơn 0');
    try {
      if (data.id) {
        const row = await this.prisma.discountCode.findUnique({ where: { id: data.id } });
        if (!row || row.venueId !== venue.id) throw new ForbiddenException('Không đúng cơ sở');
        return await this.prisma.discountCode.update({ where: { id: data.id }, data: { code, amount, active: true } });
      }
      return await this.prisma.discountCode.create({ data: { venueId: venue.id, code, amount } });
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      if (isUnique(error)) throw new BadRequestException('Mã đã có');
      throw error;
    }
  }

  async deleteDiscount(session: SessionPayload | null, id: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    const row = await this.prisma.discountCode.findUnique({ where: { id } });
    if (!row || row.venueId !== venue.id) throw new NotFoundException('Không thấy mã');
    await this.prisma.discountCode.delete({ where: { id } });
    return { ok: true };
  }

  async saveCms(session: SessionPayload | null, guide: string, priceNote: string, reviews: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    return this.prisma.cmsContent.upsert({
      where: { venueId: venue.id },
      update: { guide, priceNote, reviews },
      create: { venueId: venue.id, guide, priceNote, reviews },
    });
  }

  async createAdmin(session: SessionPayload | null, username: string, passwordHash: string, role: AdminRole, venueId: string) {
    this.assertStaff(session, [AdminRole.system_admin]);
    if (role === AdminRole.system_admin) throw new BadRequestException('Không gán role system-admin');
    if (!venueId) throw new BadRequestException('Chọn cơ sở');
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Không thấy cơ sở');
    return this.prisma.adminUser.create({
      data: { username, passwordHash, role, venueId: venue.id, createdById: session!.sub },
      select: { id: true, username: true, role: true, active: true, venue: { select: { id: true, name: true } } },
    });
  }

  async listAdmins(session: SessionPayload | null) {
    this.assertStaff(session, [AdminRole.system_admin]);
    return this.prisma.adminUser.findMany({
      where: { role: { not: AdminRole.system_admin } },
      select: { id: true, username: true, role: true, active: true, venue: { select: { id: true, name: true } } },
      orderBy: { username: 'asc' },
    });
  }

  async createReceipt(
    session: SessionPayload | null,
    input: {
      phone: string;
      guestName?: string;
      bookingId?: string;
      playTime?: string;
      playSession?: string;
      paymentMethod: PaymentMethod;
      lines: ReceiptLineInput[];
      venueId?: string;
    },
  ) {
    const staff = this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const venue = await this.resolveVenue(staff, input.venueId);
    if (!input.lines.length) throw new BadRequestException('Phiếu chưa có dữ liệu');
    const lines = await this.pricedLines(venue.id, input.lines);
    const gameLines = lines.filter((line) => line.ledger === 'game');
    const fnbLines = lines.filter((line) => line.ledger === 'fnb');
    const games = gameLines.filter((line) => line.kind === BillLineKind.subgame);
    const modes = new Set(games.map((line) => line.categoryKind).filter((mode): mode is GameKind => Boolean(mode)));
    const parents = new Set(games.map((line) => line.categoryId).filter((id): id is string => Boolean(id)));
    if (modes.size > 1 || parents.size > 1) throw new BadRequestException('Một phiếu chỉ một phòng');
    const mode = [...modes][0];
    const playTime = games.length ? (input.playTime || '').trim() : '';
    if (games.length && !playTime) throw new BadRequestException('Nhập thời gian');
    const playSession = '';
    if (input.bookingId && mode && mode !== GameKind.escape) throw new BadRequestException('Phiếu phòng này không gắn ca');
    if (input.bookingId) {
      const booking = await this.prisma.booking.findUnique({ where: { id: input.bookingId }, include: { _count: { select: { receipts: true } } } });
      if (!booking || booking.venueId !== venue.id) throw new BadRequestException('Ca không thuộc cơ sở này');
      if (booking.status === BookingStatus.cancelled) throw new BadRequestException('Ca đã hủy');
      if (booking._count.receipts > 0) throw new BadRequestException('Ca đã thanh toán');
    }
    const anchor = games[0];
    const sum = (rows: ReceiptLine[]) => rows.reduce((total, line) => total + line.qty * line.unitPrice, 0);
    const total = sum(lines);
    return this.prisma.$transaction(async (tx) => {
      if (input.bookingId) {
        const taken = await tx.receipt.findFirst({ where: { bookingId: input.bookingId }, select: { id: true } });
        if (taken) throw new BadRequestException('Ca đã thanh toán');
        const booking = await tx.booking.findUnique({ where: { id: input.bookingId }, include: { room: true } });
        if (booking?.status === BookingStatus.pending_confirm) await this.holdBooking(tx, booking);
      }
      const receipt = await tx.receipt.create({
        data: {
          venueId: venue.id,
          bookingId: input.bookingId || null,
          phone: input.phone,
          guestName: input.guestName || '',
          playTime,
          playSession,
          paymentMethod: input.paymentMethod,
          paymentStatus: 'paid',
        },
      });
      const makeBill = async (type: BillType, rows: ReceiptLine[], category?: { id?: string | null; kind?: GameKind | null }) => {
        if (!rows.length) return;
        const bill = await tx.bill.create({
          data: {
            receiptId: receipt.id,
            type,
            categoryId: category?.id || null,
            categoryKind: category?.kind || null,
            total: sum(rows),
          },
        });
        await tx.billLine.createMany({
          data: rows.map((row) => ({
            billId: bill.id,
            kind: row.kind,
            description: row.description,
            qty: row.qty,
            unitPrice: row.unitPrice,
            subGameId: row.subGameId || null,
            playerCount: row.playerCount ?? null,
          })),
        });
      };
      await makeBill(BillType.game, gameLines, anchor ? { id: anchor.categoryId, kind: anchor.categoryKind } : undefined);
      await makeBill(BillType.fnb, fnbLines);
      await tx.billPaymentHistory.create({
        data: { receiptId: receipt.id, amount: total, method: input.paymentMethod, staffId: session!.sub },
      });
      return this.receiptDetail(receipt.id, tx);
    });
  }

  private async pricedLines(venueId: string, lines: ReceiptLineInput[]) {
    if (lines.filter((line) => line.kind === BillLineKind.discount).length > 1) throw new BadRequestException('Chỉ chọn một mã giảm');
    const priced: ReceiptLine[] = [];
    for (const line of lines) {
      if (line.kind === BillLineKind.discount) {
        const code = line.code?.trim().toUpperCase();
        if (!code) throw new BadRequestException('Chọn mã giảm');
        const found = await this.prisma.discountCode.findUnique({ where: { venueId_code: { venueId, code } } });
        if (!found?.active) throw new BadRequestException('Mã giảm không dùng được');
        priced.push({
          kind: BillLineKind.discount,
          description: `Khuyến mãi ${found.code}`,
          qty: 1,
          unitPrice: -found.amount,
          ledger: 'game',
        });
        continue;
      }
      if (line.kind !== BillLineKind.subgame || !line.subGameId) {
        if (line.kind === BillLineKind.subgame && line.categoryKind && line.categoryKind !== GameKind.escape) {
          throw new BadRequestException('Chọn game');
        }
        priced.push({ ...line, playerCount: null, subGameId: line.subGameId || null, categoryId: line.categoryId || null, categoryKind: line.categoryKind || null });
        continue;
      }
      const game = await this.prisma.subGame.findUnique({ where: { id: line.subGameId }, include: { category: true } });
      if (!game || game.venueId !== venueId || !game.active || !game.category) throw new BadRequestException('Game không bán');
      if (game.category.billMode === GameKind.escape) {
        priced.push({
          ...line,
          categoryId: game.categoryId,
          categoryKind: GameKind.escape,
          subGameId: game.id,
          playerCount: null,
        });
        continue;
      }
      const playerCount = Number(line.playerCount);
      if (!Number.isInteger(playerCount) || playerCount < 1) throw new BadRequestException('Nhập số người');
      priced.push({
        kind: BillLineKind.subgame,
        description: `${game.name} · ${playerCount} người`,
        qty: 1,
        unitPrice: game.basePrice,
        ledger: 'game',
        categoryId: game.categoryId,
        categoryKind: game.category.billMode,
        subGameId: game.id,
        playerCount,
      });
    }
    const total = priced.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
    if (total < 0) throw new BadRequestException('Tổng không được âm');
    return priced;
  }

  private receiptDetail(id: string, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    return tx.receipt.findUnique({
      where: { id },
      include: { bills: { include: { lines: true } }, payments: true, booking: { include: { room: true } }, venue: true },
    });
  }

  async listReceipts(session: SessionPayload | null, date?: string, venueId?: string) {
    const staff = this.assertStaff(session);
    const venue = await this.resolveVenue(staff, venueId);
    return this.prisma.receipt.findMany({
      where: {
        venueId: venue.id,
        ...(date ? { createdAt: { gte: new Date(`${date}T00:00:00+07:00`), lt: new Date(`${date}T23:59:59+07:00`) } } : {}),
      },
      include: { bills: { include: { lines: true } }, payments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async dayRevenue(session: SessionPayload | null, date: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
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

  async closeDay(session: SessionPayload | null, date: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.edit_admin, AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    const existing = await this.prisma.dayClose.findUnique({ where: { venueId_date: { venueId: venue.id, date } } });
    if (existing) throw new BadRequestException('Ngày đã chốt');
    await this.prisma.dayClose.create({ data: { venueId: venue.id, date, closedByAdminId: session!.sub } });
    return this.dayRevenue(session, date, venue.id);
  }

  async summary(session: SessionPayload | null, year: number, period: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.system_admin]);
    const venue = await this.resolveVenue(staff, venueId);
    const closes = await this.prisma.dayClose.findMany({ where: { venueId: venue.id, date: { startsWith: String(year) } } });
    const dates = closes.map((c) => c.date).filter((d) => matchPeriod(d, year, period));
    const receipts = await this.prisma.receipt.findMany({
      where: { venueId: venue.id, paymentStatus: 'paid' },
      include: { bills: true },
    });
    const categories = await this.prisma.gameCategory.findMany({ where: { venueId: venue.id }, orderBy: { id: 'asc' } });
    const totals = new Map(categories.map((category) => [category.id, 0]));
    const defaultByMode = new Map<GameKind, string>();
    for (const category of categories) {
      if (!defaultByMode.has(category.billMode)) defaultByMode.set(category.billMode, category.id);
    }
    if (!defaultByMode.has(GameKind.sat)) {
      const satRoom = categories.find((category) => category.name === 'Kịch bản sát') || categories.find((category) => category.billMode === GameKind.board);
      if (satRoom) defaultByMode.set(GameKind.sat, satRoom.id);
    }
    let fnb = 0;
    let game = 0;
    for (const r of receipts) {
      const day = toVnDate(r.createdAt);
      if (!dates.includes(day)) continue;
      for (const b of r.bills) {
        if (b.type === 'fnb') {
          fnb += b.total;
          continue;
        }
        game += b.total;
        const bucket = b.categoryId || (b.categoryKind ? defaultByMode.get(b.categoryKind) : undefined);
        if (bucket && totals.has(bucket)) totals.set(bucket, (totals.get(bucket) || 0) + b.total);
      }
    }
    return {
      year,
      period,
      closedDays: dates.length,
      fnb,
      game,
      categories: categories.map((category) => ({ id: category.id, name: category.name, billMode: category.billMode, total: totals.get(category.id) || 0 })),
    };
  }

  async savePhoto(session: SessionPayload | null, phone: string, file: Express.Multer.File, bookingId?: string, billId?: string, caption?: string, venueId?: string) {
    const staff = this.assertStaff(session, [AdminRole.counter_admin, AdminRole.system_admin, AdminRole.edit_admin]);
    const venue = await this.resolveVenue(staff, venueId);
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

type ReceiptLineInput = {
  kind: BillLineKind;
  description: string;
  qty: number;
  unitPrice: number;
  ledger: 'game' | 'fnb';
  categoryKind?: GameKind | null;
  categoryId?: string | null;
  subGameId?: string | null;
  playerCount?: number | null;
  code?: string;
};

type ReceiptLine = {
  kind: BillLineKind;
  description: string;
  qty: number;
  unitPrice: number;
  ledger: 'game' | 'fnb';
  categoryKind?: GameKind | null;
  categoryId?: string | null;
  subGameId?: string | null;
  playerCount?: number | null;
};

function isUnique(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
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
