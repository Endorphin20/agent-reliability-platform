import { createHmac } from 'node:crypto';
import { parseIssueRef, parseRunCommand, verifyWebhookSignature } from './webhook-utils';

describe('verifyWebhookSignature', () => {
  const secret = 's3cret';
  const body = Buffer.from(JSON.stringify({ action: 'created' }));
  const sign = (s: string, b: Buffer) =>
    'sha256=' + createHmac('sha256', s).update(b).digest('hex');

  it('接受正确签名', () => {
    expect(verifyWebhookSignature(secret, body, sign(secret, body))).toBe(true);
  });

  it('拒绝错误密钥的签名', () => {
    expect(verifyWebhookSignature(secret, body, sign('wrong', body))).toBe(false);
  });

  it('拒绝被篡改的请求体', () => {
    const tampered = Buffer.from(JSON.stringify({ action: 'deleted' }));
    expect(verifyWebhookSignature(secret, tampered, sign(secret, body))).toBe(false);
  });

  it('拒绝缺失或格式错误的签名头', () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=zzzz')).toBe(false);
  });
});

describe('parseIssueRef', () => {
  it('解析 issue URL', () => {
    expect(parseIssueRef('https://github.com/o/r/issues/12')).toEqual({ repo: 'o/r', number: 12 });
  });

  it('解析 PR URL（issue 评论 API 对 PR 同样适用）', () => {
    expect(parseIssueRef('https://github.com/o/r/pull/3')).toEqual({ repo: 'o/r', number: 3 });
  });

  it('拒绝非 GitHub 或缺编号的 URL 与空值', () => {
    expect(parseIssueRef('https://gitlab.com/o/r/issues/1')).toBeNull();
    expect(parseIssueRef('https://github.com/o/r')).toBeNull();
    expect(parseIssueRef(null)).toBeNull();
    expect(parseIssueRef(undefined)).toBeNull();
  });
});

describe('parseRunCommand', () => {
  it('解析 fixtureId，默认自研 Agent', () => {
    expect(parseRunCommand('/arp run py-logic-001')).toEqual({
      fixtureId: 'py-logic-001',
      agentKind: 'SELF_LANGGRAPH',
    });
  });

  it('支持指定 agentKind', () => {
    expect(parseRunCommand('/arp run ts-api-001 MINI_SWE')).toEqual({
      fixtureId: 'ts-api-001',
      agentKind: 'MINI_SWE',
    });
  });

  it('命令可以出现在多行评论中', () => {
    expect(parseRunCommand('看起来是个 bug\n/arp run py-logic-001\n谢谢')).not.toBeNull();
  });

  it('拒绝非法 agentKind 与无关评论', () => {
    expect(parseRunCommand('/arp run x NOT_AN_AGENT')).toBeNull();
    expect(parseRunCommand('LGTM')).toBeNull();
    expect(parseRunCommand('/arp deploy prod')).toBeNull();
  });
});
