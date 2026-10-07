import 'dotenv/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CredentialStore } from './modules/credentials/credential-store';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv(); // fail fast：环境变量非法直接抛错退出
  // rawBody: GitHub webhook 验签需要原始请求体（HMAC 对序列化后的 JSON 不稳定）
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.useBodyParser('json', { limit: '10mb' });
  app.get(CredentialStore).accessToken();
  app.enableCors({ origin: process.env.ARP_WEB_ORIGIN || 'http://localhost:3000', credentials: true });
  app.enableShutdownHooks();
  await app.listen(env.PORT, process.env.ARP_BIND_HOST || '127.0.0.1');
  console.log(`control-plane listening on :${env.PORT}`);
}

void bootstrap();
