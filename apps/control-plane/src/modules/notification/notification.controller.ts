import { Controller, Get, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('api/notifications')
export class NotificationController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() async list() {
    return this.prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }
  @Post(':id/read') read(@Param('id') id: string) { return this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } }); }
}
