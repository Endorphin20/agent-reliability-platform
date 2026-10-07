import { Body, Controller, Get, Param, Post, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { PrImportService } from '../github/pr-import.service';
import { RepositoryService } from './repository.service';
import { CredentialStore } from '../credentials/credential-store';

@Controller('api/repositories')
export class RepositoryController {
  constructor(private readonly repositories: RepositoryService, private readonly github: PrImportService) {}
  @Post(':id/check') async check(@Param('id') id: string) {
    const repo = await this.repositories.get(id);
    const read = await this.github.request(`/repos/${repo.githubRepo}`, repo.readCredential);
    const write = repo.writeCredential ? await this.github.request(`/repos/${repo.githubRepo}`, repo.writeCredential) : null;
    return { readable: !!read.full_name, writeConfigured: !!repo.writeCredential,
      repositoryPushPermission: write?.permissions?.push === true,
      note: 'GitHub does not expose every fine-grained token scope here; delivery still requires Contents and Pull requests write permissions.' };
  }
  @Get() list() { return this.repositories.list(); }
  @Get(':id') get(@Param('id') id: string) { return this.repositories.get(id); }
  @Post() create(@Body() body: unknown) { return this.repositories.create(body); }
  @Post(':id/configs') configure(@Param('id') id: string, @Body() body: unknown) { return this.repositories.configure(id, body); }
}

@Controller('api/credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialStore) {}
  @Post() create(@Body() raw: unknown) {
    const input = z.object({ kind: z.enum(['github', 'model']), value: z.string().min(1) }).strict().safeParse(raw);
    if (!input.success) throw new BadRequestException('Invalid credential');
    return { reference: this.credentials.save(input.data.kind, input.data.value) };
  }
}
