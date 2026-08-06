import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv(); // fail fast：环境变量非法直接抛错退出
  // rawBody: GitHub webhook 验签需要原始请求体（HMAC 对序列化后的 JSON 不稳定）
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(`control-plane listening on :${env.PORT}`);
}

void bootstrap();
