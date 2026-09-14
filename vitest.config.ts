import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/lifecycle/**/*.test.ts'], environment: 'node', restoreMocks: true },
});
