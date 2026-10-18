import {
  BadRequestException,
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
import { AdminRole, BillLineKind, GameKind, PaymentMethod, PricingUnit } from '@prisma/client';
import { compare } from 'bcryptjs';
import type { Request, Response } from 'express';
import { HubService } from './hub.service';
import { PrismaService } from './prisma.service';
import { readSession, signSession, SessionPayload } from './auth.util';
import { qzCertificate, qzSign } from './qz-sign';

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

  @Post('auth/register')
  register(@Body() body: { name?: string; phone?: string; password?: string }) {
    return this.hub.startRegister(body.name || '', body.phone || '', body.password || '');
  }

  @Post('auth/verify')
  async verify(@Body() body: { phone?: string; code?: string }, @Res({ passthrough: true }) res: Response) {
    const user = await this.hub.confirmRegister(body.phone || '', body.code || '');
    setCookie(res, signSession({ sub: user.id, kind: 'user', phone: user.phone }));
    return { id: user.id, phone: user.phone, name: user.name };
  }

  @Post('auth/login')
  async login(@Body() body: { phone?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    const user = await this.hub.loginUser(body.phone || '', body.password || '');
    setCookie(res, signSession({ sub: user.id, kind: 'user', phone: user.phone }));
    return { id: user.id, phone: user.phone, name: user.name };
  }

  @Post('auth/admin/login')
  async adminLogin(@Body() body: { username: string; password: string }, @Res({ passthrough: true }) res: Response) {
    const admin = await this.prisma.adminUser.findUnique({ where: { username: body.username } });
    if (!admin || !admin.active || !(await compare(body.password, admin.passwordHash))) {
      throw new UnauthorizedException('Sai tài khoản');
    }
    setCookie(res, signSession({ sub: admin.id, kind: 'admin', roles: admin.roles }));
    return { id: admin.id, username: admin.username, name: admin.name, roles: admin.roles };
  }

  @Post('auth/logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('hub_session', { path: '/' });
    return { ok: true };
  }

  @Get('qz/certificate')
  async qzCert(@Req() req: Request) {
    if (sessionOf(req)?.kind !== 'admin') throw new UnauthorizedException('Cần đăng nhập admin');
    return { certificate: await qzCertificate() };
  }

  @Post('qz/sign')
  async qzSignature(@Req() req: Request, @Body() body: { request?: string }) {
    if (sessionOf(req)?.kind !== 'admin') throw new UnauthorizedException('Cần đăng nhập admin');
    const request = body.request?.trim();
    if (!request) throw new BadRequestException('Thiếu nội dung ký');
    return { signature: await qzSign(request) };
  }

  @Get('auth/me')
  async me(@Req() req: Request) {
    const session = sessionOf(req);
    if (!session) return { user: null };
    if (session.kind === 'admin') {
      const admin = await this.prisma.adminUser.findUnique({
        where: { id: session.sub },
        select: { id: true, username: true, name: true, roles: true },
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

  @Patch('bookings/:id')
  patchBooking(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { guestName: string; phone: string; email?: string; playerCount: number },
  ) {
    return this.hub.updateBooking(id, { guestName: body.guestName, phone: body.phone, email: body.email || '', playerCount: body.playerCount }, sessionOf(req));
  }

  @Post('bookings/:id/confirm')
  confirm(@Req() req: Request, @Param('id') id: string) {
    return this.hub.confirmBooking(id, sessionOf(req));
  }

  @Post('bookings/:id/cancel')
  cancel(@Req() req: Request, @Param('id') id: string, @Body() body: { note?: string }) {
    return this.hub.cancelBooking(id, sessionOf(req), body.note || '');
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
  saveGame(@Req() req: Request, @Body() body: { id?: string; name: string; code: string; basePrice: number; kind?: GameKind; categoryId?: string; pricingUnit?: PricingUnit; roomId?: string; tags?: string; active?: boolean; venueId?: string; minPlayers?: number; maxPlayers?: number; duration?: string; nightPrice?: number }) {
    return this.hub.saveSubGame(sessionOf(req), body);
  }

  @Delete('sub-games/:id')
  removeGame(@Req() req: Request, @Param('id') id: string, @Query('venueId') venueId?: string) {
    return this.hub.deleteSubGame(sessionOf(req), id, venueId);
  }

  @Get('game-categories')
  gameCategories(@Req() req: Request, @Query('venueId') venueId?: string) {
    return this.hub.listCategories(sessionOf(req), venueId);
  }

  @Post('game-categories')
  addCategory(@Req() req: Request, @Body() body: { name: string; billMode: GameKind; venueId?: string }) {
    return this.hub.saveCategory(sessionOf(req), body);
  }

  @Patch('game-categories/:id')
  renameCategory(@Req() req: Request, @Param('id') id: string, @Body() body: { name: string; venueId?: string }) {
    return this.hub.renameCategory(sessionOf(req), id, body.name, body.venueId);
  }

  @Delete('game-categories/:id')
  removeCategory(@Req() req: Request, @Param('id') id: string, @Query('venueId') venueId?: string) {
    return this.hub.deleteCategory(sessionOf(req), id, venueId);
  }

  @Post('drinks')
  saveDrink(@Req() req: Request, @Body() body: { id?: string; name: string; price: number; active?: boolean; venueId?: string; kind?: string }) {
    return this.hub.saveDrink(sessionOf(req), body);
  }

  @Delete('drinks/:id')
  removeDrink(@Req() req: Request, @Param('id') id: string, @Query('venueId') venueId?: string) {
    return this.hub.deleteDrink(sessionOf(req), id, venueId);
  }

  @Get('discounts')
  discounts(@Req() req: Request, @Query('venueId') venueId?: string) {
    return this.hub.listDiscounts(sessionOf(req), venueId);
  }

  @Post('discounts')
  saveDiscount(@Req() req: Request, @Body() body: { id?: string; code: string; percent: number; venueId?: string }) {
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
  addAdmin(@Req() req: Request, @Body() body: { name?: string; username?: string; password?: string; roles?: AdminRole[]; venueId?: string }) {
    return this.hub.createAdmin(sessionOf(req), body);
  }

  @Patch('admins/:id')
  updateAdmin(@Req() req: Request, @Param('id') id: string, @Body() body: { name?: string; username?: string; password?: string; roles?: AdminRole[]; venueId?: string }) {
    return this.hub.updateAdmin(sessionOf(req), id, body);
  }

  @Delete('admins/:id')
  removeAdmin(@Req() req: Request, @Param('id') id: string) {
    return this.hub.deleteAdmin(sessionOf(req), id);
  }

  @Post('receipts')
  receipt(
    @Req() req: Request,
    @Body()
    body: {
      phone: string;
      guestName?: string;
      bookingId?: string;
      playTime?: string;
      playSession?: string;
      paymentMethod: PaymentMethod;
      lines: { kind: BillLineKind; description: string; qty: number; unitPrice: number; ledger: 'game' | 'fnb'; categoryKind?: GameKind; categoryId?: string; subGameId?: string; playerCount?: number; code?: string; shift?: 'day' | 'night' }[];
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

  @Patch('me')
  patchMe(@Req() req: Request, @Body() body: { name?: string; email?: string; password?: string }) {
    return this.hub.updateProfile(sessionOf(req), body.name || '', body.email || '', body.password || '');
  }

  @Post('contact')
  contact(@Body() body: { name: string; phone: string; content: string }) {
    return this.hub.contact(body.name, body.phone, body.content);
  }
}
