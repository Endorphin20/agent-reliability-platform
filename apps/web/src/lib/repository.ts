export interface RepositoryConfig {
  defaultDelivery?: 'patch' | 'pull-request';
  runtime: 'python-pytest'; preparation: 'image' | 'requirements'; image: string;
  dependencyFiles: string[]; workdir: string; allowedPaths: string[]; protectedPaths: string[];
  staticCheck: string[]; failToPass: string[]; passToPass: string[]; acceptanceCriteria: string[];
}
export interface Repository {
  id: string; name: string; repoPath: string; repoUrl: string; defaultBranch: string;
  configs: { version: number; config: RepositoryConfig }[];
}
export const defaultConfig: RepositoryConfig = {
  runtime: 'python-pytest', preparation: 'image', image: 'arp-sandbox:latest', dependencyFiles: [],
  workdir: '.', allowedPaths: ['src/**'], protectedPaths: ['tests/**', '**/conftest.py'],
  staticCheck: [], failToPass: ['python -m pytest -q'], passToPass: [], acceptanceCriteria: ['原失败检查通过，回归检查无新增失败'],
};
export function lines(text: string) { return text.split('\n').map((s) => s.trim()).filter(Boolean); }
