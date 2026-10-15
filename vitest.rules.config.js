import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/rules/**/*.test.js'], testTimeout: 20000 },
});
