import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { HubService } from './hub.service';
import { PrismaService } from './prisma.service';

@Module({
  controllers: [AppController],
  providers: [HubService, PrismaService],
})
export class AppModule {}
