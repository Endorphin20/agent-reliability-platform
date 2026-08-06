import { createHmac, timingSafeEqual } from 'node:crypto';
import { AGENT_KINDS } from '@arp/shared';

/** X-Hub-Signature-256 验签（HMAC-SHA256 over 原始请求体）。 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

/** issue 评论里的触发命令：/arp run <fixtureId> [agentKind] */
export function parseRunCommand(
  comment: string,
): { fixtureId: string; agentKind: (typeof AGENT_KINDS)[number] } | null {
  // 只允许行内空白分隔：\s 会跨行把下一行文本吞成 agentKind
  const match = comment.match(/^\/arp[ \t]+run[ \t]+(\S+)(?:[ \t]+(\S+))?[ \t]*$/m);
  if (!match) return null;
  const agentKind = (match[2] ?? 'SELF_LANGGRAPH') as (typeof AGENT_KINDS)[number];
  if (!AGENT_KINDS.includes(agentKind)) return null;
  return { fixtureId: match[1], agentKind };
}
