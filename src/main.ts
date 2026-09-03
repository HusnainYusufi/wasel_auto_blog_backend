import 'reflect-metadata';
import { setDefaultResultOrder } from 'dns';
import { NestFactory } from '@nestjs/core';

// api.minimax.io publishes AAAA records. On IPv4-only networks Node's fetch
// prefers the IPv6 address and hangs until timeout, so resolve IPv4 first.
setDefaultResultOrder('ipv4first');
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:3100')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const port = Number(process.env.PORT ?? 4100);
  await app.listen(port);
  new Logger('Bootstrap').log(`Wasel Auto Blog API ready on http://localhost:${port}/api`);
}

void bootstrap();
