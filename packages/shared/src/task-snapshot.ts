import { z } from 'zod';
import { AGENT_KINDS } from './enums';

export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const RelativePathSchema = z.string().min(1).max(512).refine(
  (value) => !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').includes('..') && !/[\x00-\x1f]/.test(value),
  'Path must stay within the repository',
);
const CommandSchema = z.string().trim().min(1).max(4096);
export const RepositoryConfigSchema = z.object({
  runtime: z.enum(['python-pytest']),
  defaultDelivery: z.enum(['patch', 'pull-request']).optional(),
  preparation: z.enum(['image', 'requirements']),
  image: z.string().min(1).max(512),
  dependencyFiles: z.array(RelativePathSchema).default([]),
  workdir: RelativePathSchema.default('.'),
  allowedPaths: z.array(RelativePathSchema).min(1),
  protectedPaths: z.array(RelativePathSchema).default([]),
  staticCheck: z.array(CommandSchema),
  failToPass: z.array(CommandSchema),
  passToPass: z.array(CommandSchema),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
}).strict();

export const TaskSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  mode: z.literal('REAL'),
  repositoryId: z.string().min(1),
  parentTaskId: z.string().min(1).optional(),
  configVersion: z.number().int().positive(),
  executionSha: GitShaSchema,
  agentKind: z.enum(AGENT_KINDS),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(100000),
  config: RepositoryConfigSchema,
  baseline: z.object({ command: CommandSchema, expected: z.array(z.string().min(1)).min(1) }).strict(),
  budget: z.object({
    tokens: z.number().int().positive().max(10000000),
    seconds: z.number().int().positive().max(86400),
    turns: z.number().int().positive().max(1000),
    maxAttempts: z.number().int().positive().max(20),
  }).strict(),
  delivery: z.object({
    kind: z.enum(['patch', 'pull-request']),
    targetBranch: z.string().min(1).max(255),
    expectedTargetSha: GitShaSchema,
  }).strict(),
  source: z.object({
    prUrl: z.string().url(), headSha: GitShaSchema, baseSha: GitShaSchema,
    ciSha: z.string().nullable(), evidence: z.string().max(100000),
  }).strict().optional(),
}).strict();

export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
