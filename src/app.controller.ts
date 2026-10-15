import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AdminRole, BillLineKind, GameKind, PaymentMethod } from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import type { Request, Response } from 'express';
import { HubService } from './hub.service';
import { PrismaService } from './prisma.service';
import { readSession, signSession, SessionPayload } from './auth.util';

function sessionOf(req: Request): SessionPayload | null {
  return readSession(req.cookies?.hub_session);
}

function setCookie(res: Response, token: string) {
  res.cookie('hub_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
  });
}

@Controller()
export class AppController {
  constructor(
    private readonly hub: HubService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  @Post('auth/otp')
  otp(@Body() body: { phone: string }) {
    return this.hub.requestOtp(body.phone);
  }

  @Post('auth/verify')
  async verify(@Body() body: { phone: string; code: string; name?: string; email?: string }, @Res({ passthrough: true }) res: Response) {
    const user = await this.hub.verifyOtp(body.phone, body.code, body.name, body.email);
    setCookie(res, signSession({ sub: user.id, kind: 'user', phone: user.phone }));
    return { id: user.id, phone: user.phone, name: user.name };
  }

  @Post('auth/admin/login')
  async adminLogin(@Body() body: { username: string; password: string }, @Res({ passthrough: true }) res: Response) {
    const admin = await this.prisma.adminUser.findUnique({ where: { username: body.username } });
    if (!admin || !admin.active || !(await compare(body.password, admin.passwordHash))) {
      throw new UnauthorizedException('Sai tài khoản');
    }
    setCookie(res, signSession({ sub: admin.id, kind: 'admin', role: admin.role }));
    return { id: admin.id, username: admin.username, role: admin.role };
  }

  @Post('auth/logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('hub_session', { path: '/' });
    return { ok: true };
  }

  @Get('auth/me')
  async me(@Req() req: Request) {
    const session = sessionOf(req);
    if (!session) return { user: null };
    if (session.kind === 'admin') {
      const admin = await this.prisma.adminUser.findUnique({
        where: { id: session.sub },
        select: { id: true, username: true, role: true },
      });
      return { user: admin ? { ...admin, kind: 'admin' } : null };
    }
    const user = await this.prisma.user.findUnique({ where: { id: session.sub } });
    return { user: user ? { id: user.id, phone: user.phone, name: user.name, kind: 'user' } : null };
  }

  @Get('venues')
  venues(@Req() req: Request) {
    return this.hub.listVenues(sessionOf(req));
  }

  @Post('venues')
  createVenue(@Req() req: Request, @Body() body: { code: string; name: string; address: string; phone?: string }) {
    return this.hub.createVenue(sessionOf(req), body);
  }

  @Patch('venues/:id')
  patchVenue(@Req() req: Request, @Param('id') id: string, @Body() body: { code?: string; name?: string; address?: string; phone?: string; active?: boolean }) {
    return this.hub.updateVenue(sessionOf(req), id, body);
  }

  @Delete('venues/:id')
  removeVenue(@Req() req: Request, @Param('id') id: string) {
    return this.hub.deleteVenue(sessionOf(req), id);
  }

  @Get('home')
  home(@Req() req: Request, @Query('venueId') venueId?: string) {
    return this.hub.publicHome(sessionOf(req), venueId);
  }

  @Get('slots')
  slots(@Req() req: Request, @Query('roomId') roomId: string, @Query('date') date: string, @Query('venueId') venueId?: string) {
    return this.hub.slotsFor(roomId, date, sessionOf(req), venueId);
  }

  @Get('bookings')
  bookings(@Req() req: Request, @Query('from') from: string, @Query('to') to: string, @Query('venueId') venueId?: string) {
    return this.hub.weekBookings(from, to, sessionOf(req), venueId);
  }

  @Post('bookings')
  createBooking(
    @Req() req: Request,
    @Body()
    body: {
      roomId: string;
      date: string;
      slotIndexes: number[];
      guestName: string;
      email: string;
      phone: string;
      playerCount: number;
      note?: string;
      venueId?: string;
    },
  ) {
    const session = sessionOf(req);
    return this.hub.createBooking({ ...body, userId: session?.kind === 'user' ? session.sub : undefined }, session);
  }

  @Post('bookings/:id/confirm')
  confirm(@Req() req: Request, @Param('id') id: string) {
    return this.hub.confirmBooking(id, sessionOf(req));
  }

  @Post('bookings/:id/cancel')
  cancel(@Req() req: Request, @Param('id') id: string) {
    return this.hub.cancelBooking(id, sessionOf(req));
  }

  @Patch('slots/:id')
  patchSlot(@Req() req: Request, @Param('id') id: string, @Body() body: { startTime: string; endTime: string; enabled?: boolean }) {
    return this.hub.updateSlot(id, body.startTime, body.endTime, body.enabled ?? true, sessionOf(req));
  }

  @Post('rooms')
  saveRoom(@Req() req: Request, @Body() body: { id?: string; name: string; code: string; capacity: number; description?: string; active?: boolean; venueId?: string }) {
    return this.hub.saveRoom(sessionOf(req), body);
  }

  @Delete('rooms/:id')
  removeRoom(@Req() req: Request, @Param('id') id: string, @Query('venueId') venueId?: string) {
    return this.hub.deleteRoom(sessionOf(req), id, venueId);
  }

  @Post('sub-games')
  saveGame(@Req() req: Request, @Body() body: { id?: string; name: string; code: string; basePrice: number; kind: GameKind; roomId?: string; tags?: string; active?: boolean; venueId?: string }) {
    return this.hub.saveSubGame(sessionOf(req), body);
  }

  @Post('drinks')
  saveDrink(@Req() req: Request, @Body() body: { id?: string; name: string; price: number; active?: boolean; venueId?: string }) {
    return this.hub.saveDrink(sessionOf(req), body);
  }

  @Get('discounts')
  discounts(@Req() req: Request, @Query('venueId') venueId?: string) {
    return this.hub.listDiscounts(sessionOf(req), venueId);
  }

  @Post('discounts')
  saveDiscount(@Req() req: Request, @Body() body: { id?: string; code: string; amount: number; venueId?: string }) {
    return this.hub.saveDiscount(sessionOf(req), body);
  }

  @Delete('discounts/:id')
  removeDiscount(@Req() req: Request, @Param('id') id: string, @Query('venueId') venueId?: string) {
    return this.hub.deleteDiscount(sessionOf(req), id, venueId);
  }

  @Post('cms')
  cms(@Req() req: Request, @Body() body: { guide: string; priceNote: string; reviews: string; venueId?: string }) {
    return this.hub.saveCms(sessionOf(req), body.guide, body.priceNote, body.reviews, body.venueId);
  }

  @Get('admins')
  admins(@Req() req: Request) {
    return this.hub.listAdmins(sessionOf(req));
  }

  @Post('admins')
  async addAdmin(@Req() req: Request, @Body() body: { username: string; password: string; role: AdminRole; venueId: string }) {
    const passwordHash = await hash(body.password, 10);
    return this.hub.createAdmin(sessionOf(req), body.username, passwordHash, body.role, body.venueId);
  }

  @Post('receipts')
  receipt(
    @Req() req: Request,
    @Body()
    body: {
      phone: string;
      guestName?: string;
      bookingId?: string;
      paymentMethod: PaymentMethod;
      lines: { kind: BillLineKind; description: string; qty: number; unitPrice: number; ledger: 'game' | 'fnb'; categoryKind?: GameKind; code?: string }[];
      venueId?: string;
    },
  ) {
    return this.hub.createReceipt(sessionOf(req), body);
  }

  @Get('receipts')
  receipts(@Req() req: Request, @Query('date') date?: string, @Query('venueId') venueId?: string) {
    return this.hub.listReceipts(sessionOf(req), date, venueId);
  }

  @Get('revenue/day')
  day(@Req() req: Request, @Query('date') date: string, @Query('venueId') venueId?: string) {
    return this.hub.dayRevenue(sessionOf(req), date, venueId);
  }

  @Post('revenue/close')
  close(@Req() req: Request, @Body() body: { date: string; venueId?: string }) {
    return this.hub.closeDay(sessionOf(req), body.date, body.venueId);
  }

  @Get('revenue/summary')
  summary(@Req() req: Request, @Query('year') year: string, @Query('period') period: string, @Query('venueId') venueId?: string) {
    return this.hub.summary(sessionOf(req), Number(year), period || 'year', venueId);
  }

  @Post('photos')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  photo(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { phone: string; bookingId?: string; billId?: string; caption?: string; venueId?: string },
  ) {
    return this.hub.savePhoto(sessionOf(req), body.phone, file, body.bookingId, body.billId, body.caption, body.venueId);
  }

  @Get('me')
  meData(@Req() req: Request) {
    return this.hub.myData(sessionOf(req));
  }

  @Post('contact')
  contact(@Body() body: { name: string; phone: string; content: string }) {
    return this.hub.contact(body.name, body.phone, body.content);
  }
}
