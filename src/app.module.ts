import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { join } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { MinimaxModule } from './minimax/minimax.module';
import { BlogModule } from './blog/blog.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Blanket limit; the login route tightens this further.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
      serveStaticOptions: { index: false, fallthrough: true },
    }),
    PrismaModule,
    AuthModule,
    MinimaxModule,
    KnowledgeModule,
    BlogModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate, then rate-limit, then authorize by role.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
