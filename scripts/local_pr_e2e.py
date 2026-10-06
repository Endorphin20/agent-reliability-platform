"""Local integration harness: real API/PG/Redis/Worker/Docker; scripted model endpoint.

No GitHub write and no paid model call. Uses a fresh test database and Redis DB 8.
"""
import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import psycopg

ROOT = Path(__file__).resolve().parents[1]
PATCH = 'diff --git a/src/bug.py b/src/bug.py\n--- a/src/bug.py\n+++ b/src/bug.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n'


class Model(BaseHTTPRequestHandler):
    calls = 0
    def log_message(self, *_):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).calls += 1
        tool_results = [m for m in body['messages'] if m['role'] == 'tool']
        message = {'role': 'assistant', 'content': 'FINISH'}
        if not tool_results:
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                'id': 'patch-1', 'type': 'function', 'function': {'name': 'apply_patch', 'arguments': json.dumps({'patch': PATCH})}}]}
        result = {'id': 'chatcmpl-local-test', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'local-test',
            'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if 'tool_calls' in message else 'stop'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 50, 'total_tokens': 150}}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(result).encode())


def main():
    database = 'arp_local_pr_e2e_' + uuid.uuid4().hex[:10]
    pg_base = os.environ.get('ARP_TEST_POSTGRES', 'postgresql://arp:arp@127.0.0.1:55432')
    with psycopg.connect(pg_base + '/postgres', autocommit=True) as connection:
        connection.execute(psycopg.sql.SQL('CREATE DATABASE {}').format(psycopg.sql.Identifier(database)))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    processes = []
    with tempfile.TemporaryDirectory(prefix='arp-local-e2e-') as temporary:
        root = Path(temporary); repo = root / 'repo'; repo.mkdir(); (repo / 'src').mkdir(); (repo / 'tests').mkdir()
        (repo / 'src/bug.py').write_text('def add(a, b):\n    return a - b\n')
        (repo / 'tests/test_bug.py').write_text('from src.bug import add\ndef test_add():\n    assert add(2, 3) == 5\n')
        def git(*args):
            return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()
        git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test', 'commit', '-m', 'bug')
        sha = git('rev-parse', 'HEAD')
        env = {**os.environ, 'DATABASE_URL': pg_base + '/' + database, 'REDIS_URL': 'redis://127.0.0.1:56379/8',
            'ARP_DATA_DIR': str(root / 'state'), 'PORT': '3899', 'CONTROL_PLANE_URL': 'http://127.0.0.1:3899',
            'NODE_ENV': 'production', 'ARP_PUBLIC_DEMO': 'false', 'MOCK_MODE': 'false', 'LLM_PROVIDER': 'openai',
            'LLM_BASE_URL': f'http://127.0.0.1:{server.server_port}/v1', 'LLM_API_KEY': 'local-scripted-endpoint',
            'LLM_MODEL': 'local-test', 'LLM_CONTEXT_TOKEN_LIMIT': '4096', 'LLM_MAX_OUTPUT_TOKENS': '1024',
            'JUDGE_LLM_MODEL': '', 'JUDGE_LLM_API_KEY': '', 'CONTEXT_MODE': 'fold', 'FAULT_INJECT': '',
            'WORKER_ID': 'local-e2e-' + uuid.uuid4().hex[:8], 'GITHUB_ENABLED': 'false'}
        log_path = ROOT / '.e2e-logs/local-pr.log'; log_path.parent.mkdir(exist_ok=True)
        with log_path.open('w') as log:
            try:
                subprocess.run(['pnpm', '-C', 'apps/control-plane', 'exec', 'prisma', 'migrate', 'deploy'], cwd=ROOT, env=env, stdout=log, stderr=log, check=True)
                processes.append(subprocess.Popen(['node', 'dist/src/main.js'], cwd=ROOT / 'apps/control-plane', env=env, stdout=log, stderr=log))
                client = httpx.Client(base_url=env['CONTROL_PLANE_URL'], timeout=15)
                for _ in range(60):
                    try:
                        if client.get('/api/health').is_success: break
                    except httpx.HTTPError: pass
                    time.sleep(.5)
                else: raise RuntimeError('API startup failed; see .e2e-logs/local-pr.log')
                # The guard creates the access key on its first authenticated request.
                client.get('/api/repositories')
                token = (root / 'state/access-token').read_text().strip()
                client.headers['Authorization'] = f'Bearer {token}'
                def post(path, body):
                    response = client.post(path, json=body)
                    if not response.is_success: raise RuntimeError(f'{path}: {response.status_code} {response.text[:500]}')
                    return response.json()
                config = dict(runtime='python-pytest', preparation='image', image='arp-sandbox:latest', dependencyFiles=[],
                    workdir='.', allowedPaths=['src/**'], protectedPaths=['tests/**'], staticCheck=[],
                    failToPass=['python -m pytest -q tests/test_bug.py'], passToPass=['python -m pytest -q'], acceptanceCriteria=['addition works'])
                project = post('/api/repositories', dict(name='Local E2E', repoPath=str(repo), repoUrl='https://github.com/example/local-e2e', defaultBranch='main', config=config))
                draft = post('/api/drafts', dict(schemaVersion=2, mode='REAL', repositoryId=project['id'], configVersion=1,
                    executionSha=sha, agentKind='SELF_LANGGRAPH', title='Fix add', description='Fix addition without changing tests.', config=config,
                    baseline=dict(command='python -m pytest -q tests/test_bug.py', expected=['tests/test_bug.py::test_add']),
                    budget=dict(tokens=20000, seconds=180, turns=10, maxAttempts=3),
                    delivery=dict(kind='patch', targetBranch='main', expectedTargetSha=sha)))
                task = post(f'/api/drafts/{draft["id"]}/confirm', dict(revision=1, idempotencyKey=uuid.uuid4().hex, testsConfirmed=True))
                # The original checkout moves after confirmation: the task must still execute its SHA.
                (repo / 'unrelated.txt').write_text('branch advanced'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test', 'commit', '-m', 'advance')
                processes.append(subprocess.Popen([str(ROOT / 'apps/agent-runtime/.venv/bin/python'), '-m', 'arp_runtime.worker'], cwd=ROOT / 'apps/agent-runtime', env=env, stdout=log, stderr=log))
                for _ in range(180):
                    result = client.get('/api/runs/' + task['runId']).json()
                    if result['status'] in ['SUCCEEDED', 'FAILED', 'INTERRUPTED']: break
                    time.sleep(1)
                assert result['status'] == 'SUCCEEDED', (result['status'], result['task']['attentionReason'], str(log_path))
                assert result['baseCommit'] == sha and result['imageId'].startswith('sha256:')
                assert result['usedTokens'] == 300, result['usedTokens']
                patch = client.get(f'/api/runs/{task["runId"]}/diff').json()['content']
                assert '+    return a + b' in patch
                task_info = client.get('/api/tasks/' + task['taskId']).json()
                post(f'/api/approvals/{task_info["approval"]["id"]}/decide', dict(decision='APPROVED'))
                assert client.get('/api/tasks/' + task['taskId']).json()['status'] == 'RESOLVED'
                assert Model.calls == 2, Model.calls
                print(json.dumps({'result': 'PASS', 'model': 'scripted local HTTP endpoint', 'githubWrites': 0,
                    'database': database, 'checks': ['repository configuration', 'fixed SHA after branch advance', 'baseline reproduction', 'Docker repair', 'clean validation', 'budget ledger', 'patch approval']}, indent=2))
            finally:
                for process in reversed(processes):
                    process.terminate()
                    try: process.wait(timeout=10)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()
                server.shutdown()


if __name__ == '__main__':
    main()
