import { isLocalOrigin, tokenMatches } from './local-auth.guard';
it('rejects forged browser origins and accepts only configured local UI', () => {
  expect(isLocalOrigin('https://evil.example', 'http://localhost:3000')).toBe(false);
  expect(isLocalOrigin('http://localhost:3000', 'http://localhost:3000')).toBe(true);
  expect(isLocalOrigin(undefined, 'http://localhost:3000')).toBe(true);
});
it('requires nonempty exact tokens', () => {
  expect(tokenMatches('', '')).toBe(false);
  expect(tokenMatches('secret', 'secre')).toBe(false);
  expect(tokenMatches('secret', 'secret')).toBe(true);
});
