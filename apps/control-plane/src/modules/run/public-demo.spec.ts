import { assertDemoInput, assertDemoCapacity } from './public-demo';

describe('public demo boundaries', () => {
  it('accepts a bounded self-agent fixture', () => {
    expect(() => assertDemoInput({ fixtureId: 'py-logic-001', agentKind: 'SELF_LANGGRAPH' })).not.toThrow();
  });
  it.each([
    { fixtureId: 'swb-unknown', agentKind: 'SELF_LANGGRAPH' },
    { fixtureId: 'py-logic-001', agentKind: 'MINI_SWE' },
    { fixtureId: 'py-logic-001', agentKind: 'SELF_LANGGRAPH', budgetSeconds: 99999 },
  ])('rejects unsupported or unbounded requests', input => {
    expect(() => assertDemoInput(input)).toThrow();
  });
  it('rejects new runs while one is active or the daily allowance is spent', () => {
    expect(() => assertDemoCapacity(1, 2)).toThrow();
    expect(() => assertDemoCapacity(0, 100)).toThrow();
    expect(() => assertDemoCapacity(0, 0)).not.toThrow();
  });
});
