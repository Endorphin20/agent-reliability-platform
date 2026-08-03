import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv(); // fail fast：环境变量非法直接抛错退出
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(`control-plane listening on :${env.PORT}`);
}

void bootstrap();
