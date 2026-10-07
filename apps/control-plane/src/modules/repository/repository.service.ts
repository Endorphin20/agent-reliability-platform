import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RepositoryConfigSchema } from '@arp/shared';
import { z } from 'zod';
import { realpath, stat } from 'node:fs/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { GitStore } from './git-store';

export const RepositoryInput = z.object({
  name: z.string().min(1).max(200), repoPath: z.string().min(1),
  repoUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/),
  defaultBranch: z.string().min(1).default('main'),
  readCredential: z.string().regex(/^github-[a-f0-9-]{36}$/).optional(),
  writeCredential: z.string().regex(/^github-[a-f0-9-]{36}$/).optional(),
  config: RepositoryConfigSchema,
}).strict();

@Injectable()
export class RepositoryService {
  constructor(private readonly prisma: PrismaService, private readonly git: GitStore) {}
  list() { return this.prisma.project.findMany({ where: { repoUrl: { not: null } }, include: {
    configs: { orderBy: { version: 'desc' }, take: 1 },
  }, orderBy: { createdAt: 'desc' } }); }
  async get(id: string) {
    const project = await this.prisma.project.findUnique({ where: { id }, include: { configs: { orderBy: { version: 'desc' } } } });
    if (!project?.repoUrl) throw new NotFoundException('Repository not found');
    return project;
  }
  async create(raw: unknown) {
    const parsed = RepositoryInput.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const repoPath = await realpath(input.repoPath);
    if (!(await stat(repoPath)).isDirectory()) throw new BadRequestException('Repository path is not a directory');
    await this.git.resolve(repoPath, input.defaultBranch);
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findFirst() ?? await tx.workspace.create({ data: { name: 'Local' } });
      return tx.project.create({ data: {
        workspaceId: workspace.id, name: input.name, repoPath, repoUrl: input.repoUrl,
        githubRepo: new URL(input.repoUrl).pathname.slice(1).replace(/\.git$/, ''),
        defaultBranch: input.defaultBranch, readCredential: input.readCredential, writeCredential: input.writeCredential,
        configs: { create: { version: 1, config: input.config } },
      }, include: { configs: true } });
    });
  }
  async configure(id: string, raw: unknown) {
    const parsed = RepositoryConfigSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Project" WHERE id = ${id} FOR UPDATE`;
      const last = await tx.repositoryConfigVersion.findFirst({ where: { projectId: id }, orderBy: { version: 'desc' } });
      return tx.repositoryConfigVersion.create({ data: { projectId: id, version: (last?.version ?? 0) + 1, config: parsed.data } });
    });
  }
}
