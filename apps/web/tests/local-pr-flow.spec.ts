import { test, expect } from '@playwright/test';

const config = { runtime: 'python-pytest', preparation: 'image', image: 'arp-sandbox:latest', dependencyFiles: [],
  workdir: '.', allowedPaths: ['src/**'], protectedPaths: ['tests/**'], staticCheck: [],
  failToPass: ['python -m pytest -q'], passToPass: [], acceptanceCriteria: ['fix bug'] };
test.beforeEach(async ({ page }) => {
  await page.route('**/api/notifications', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/repositories', (route) => route.fulfill({ json: [{ id: 'repo1', name: 'Python demo',
    repoPath: '/tmp/demo', repoUrl: 'https://github.com/example/demo', defaultBranch: 'main', configs: [{ version: 1, config }] }] }));
});
test('explicit test confirmation gates task queueing and preserves SHA', async ({ page }) => {
  let queued = false;
  await page.route('**/api/drafts', async (route) => {
    expect(route.request().postDataJSON().executionSha).toBe('a'.repeat(40));
    await route.fulfill({ json: { id: 'draft1', revision: 1 } });
  });
  await page.route('**/api/drafts/draft1/confirm', async (route) => {
    expect(route.request().postDataJSON().testsConfirmed).toBe(true);
    queued = true; await route.fulfill({ json: { runId: 'run1' } });
  });
  await page.route('**/api/runs/run1', (route) => route.fulfill({ json: { id: 'run1', status: 'DISPATCHED', phase: 'QUEUED',
    agentKind: 'SELF_LANGGRAPH', usedTokens: 0, usedSeconds: 0, budgetTokens: 200000, budgetSeconds: 900, budgetTurns: 30,
    task: { snapshot: {}, attentionReason: null }, artifacts: [], attempts: [], policyDecisions: [] } }));
  await page.route('**/api/runs/run1/events', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/runs/run1/events/stream', (route) => route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' }));
  await page.goto('/tasks/new');
  await page.getByRole('combobox', { name: '仓库', exact: true }).selectOption('repo1');
  await page.getByLabel('任务名称').fill('Fix parser');
  await page.getByLabel('准确提交 SHA').fill('a'.repeat(40));
  await page.getByLabel('问题描述').fill('Parser fails on empty input');
  await page.getByLabel('预期失败标识', { exact: false }).fill('test_empty');
  await page.getByRole('button', { name: '生成确认摘要' }).click();
  await expect(page.getByRole('button', { name: '确认并排队' })).toBeDisabled();
  expect(queued).toBe(false);
  await expect(page.getByText('未配置：本次不能承诺回归测试已通过')).toBeVisible();
  await page.getByLabel('我确认指定检查', { exact: false }).check();
  await page.getByRole('button', { name: '确认并排队' }).click();
  await expect(page).toHaveURL(/runs\/run1/);
  expect(queued).toBe(true);
  await expect(page.getByText('当前阶段：排队', { exact: false })).toBeVisible();
});
test('repository configurations are reusable without exposing saved secrets', async ({ page }) => {
  await page.goto('/repositories');
  await expect(page.getByText('Python demo')).toBeVisible();
  await page.getByRole('button', { name: '更新配置' }).click();
  await expect(page.getByLabel('镜像名称或 ID')).toHaveValue('arp-sandbox:latest');
  await expect(page.getByLabel('定向测试命令')).toHaveValue('python -m pytest -q');
  await expect(page.getByLabel('读取 Token', { exact: false })).toHaveCount(0);
});
