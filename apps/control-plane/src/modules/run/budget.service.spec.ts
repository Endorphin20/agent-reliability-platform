import { availableBudget } from './budget.service';
it('counts unsettled calls against the task budget across retries', () => {
  expect(availableBudget(100, [{ reserved: 40, used: null }, { reserved: 50, used: 20 }])).toBe(40);
});
it('does not refund unknown call usage', () => {
  expect(availableBudget(100, [{ reserved: 100, used: null }])).toBe(0);
});
it('never returns a negative balance', () => {
  expect(availableBudget(50, [{ reserved: 100, used: 80 }])).toBe(0);
});
