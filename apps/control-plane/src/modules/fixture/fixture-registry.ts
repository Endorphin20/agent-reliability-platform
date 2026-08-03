import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { TaskSpec } from '@arp/shared';
import { loadEnv } from '../../config/env';

export interface FixtureDefinition {
  id: string;
  title: string;
  category: string;
  repoPath: string;
  baseCommit: string; // git ref（tag），沙箱 checkout 用
  goldPatch: string;
  acceptanceCriteria: string[];
  taskSpec: TaskSpec;
}

interface TaskYaml {
  id: string;
  title: string;
  category: string;
  language: string;
  workdir: string;
  base_ref: string;
  description: string;
  allowed_paths: string[];
  setup: string[];
  static_check: string[];
  fail_to_pass: string[];
  pass_to_pass: string[];
  gold_patch: string;
  acceptance_criteria: string[];
}

/**
 * fixture 任务注册表：启动时从 agent-fixture-repo/tasks/<id>/task.yaml 加载（§4.9），
 * 另有内置假任务 "fake"（T4 空转闭环与 CI 用）。
 */
@Injectable()
export class FixtureRegistry {
  private readonly logger = new Logger(FixtureRegistry.name);
  private cache?: Map<string, FixtureDefinition>;

  private repoPath(): string {
    return loadEnv().FIXTURE_REPO_PATH.replace(/^~/, homedir());
  }

  private load(): Map<string, FixtureDefinition> {
    if (this.cache) return this.cache;
    const map = new Map<string, FixtureDefinition>();
    map.set('fake', {
      id: 'fake',
      title: '空转闭环假任务',
      category: 'internal',
      repoPath: '/tmp/arp-fake-repo',
      baseCommit: 'main',
      goldPatch: '',
      acceptanceCriteria: [],
      taskSpec: {
        fixtureId: 'fake',
        description: '假执行器任务：产出 10 个脚本化事件后成功',
        workdir: '.',
        allowedPaths: ['**'],
        staticCheck: [],
        failToPass: [],
        passToPass: [],
        acceptanceCriteria: [],
      },
    });

    const tasksDir = join(this.repoPath(), 'tasks');
    if (existsSync(tasksDir)) {
      for (const id of readdirSync(tasksDir)) {
        const yamlPath = join(tasksDir, id, 'task.yaml');
        if (!existsSync(yamlPath)) continue;
        try {
          const raw = parse(readFileSync(yamlPath, 'utf8')) as TaskYaml;
          map.set(raw.id, {
            id: raw.id,
            title: raw.title,
            category: raw.category,
            repoPath: this.repoPath(),
            baseCommit: raw.base_ref,
            goldPatch: raw.gold_patch,
            acceptanceCriteria: raw.acceptance_criteria ?? [],
            taskSpec: {
              fixtureId: raw.id,
              description: raw.description,
              workdir: raw.workdir,
              allowedPaths: raw.allowed_paths,
              staticCheck: raw.static_check ?? [],
              failToPass: raw.fail_to_pass ?? [],
              passToPass: raw.pass_to_pass ?? [],
              acceptanceCriteria: raw.acceptance_criteria ?? [],
            },
          });
        } catch (error) {
          this.logger.error(`解析 ${yamlPath} 失败: ${String(error)}`);
        }
      }
    } else {
      this.logger.warn(`fixture 仓库不存在: ${tasksDir}，只有内置 fake 任务可用`);
    }
    this.logger.log(`已加载 ${map.size} 个 fixture 任务`);
    this.cache = map;
    return map;
  }

  get(fixtureId: string): FixtureDefinition {
    const def = this.load().get(fixtureId);
    if (!def) {
      throw new NotFoundException(`未知 fixture: ${fixtureId}`);
    }
    return def;
  }

  list(): FixtureDefinition[] {
    return [...this.load().values()];
  }
}
