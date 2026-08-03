import { z } from 'zod';

/**
 * 环境变量单点校验（fail fast）：缺失/非法在应用启动时立刻抛错，
 * 而不是在运行到某个功能时才发现。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3001),
  LEASE_TTL_MS: z.coerce.number().int().positive().default(30000),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),
  FIXTURE_REPO_PATH: z.string().default('~/Coding/agent-reliability/agent-fixture-repo'),
  GITHUB_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(source);
    if (!parsed.success) {
      throw new Error(`环境变量校验失败: ${JSON.stringify(parsed.error.issues)}`);
    }
    if (parsed.data.GITHUB_ENABLED) {
      const missing = [
        ['GITHUB_APP_ID', parsed.data.GITHUB_APP_ID],
        ['GITHUB_APP_PRIVATE_KEY_PATH', parsed.data.GITHUB_APP_PRIVATE_KEY_PATH],
        ['GITHUB_WEBHOOK_SECRET', parsed.data.GITHUB_WEBHOOK_SECRET],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
      if (missing.length > 0) {
        throw new Error(`GITHUB_ENABLED=true 但缺少: ${missing.join(', ')}`);
      }
    }
    cached = parsed.data;
  }
  return cached;
}

export function resetEnvCacheForTest(): void {
  cached = undefined;
}
