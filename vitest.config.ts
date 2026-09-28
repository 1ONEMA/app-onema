import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test', DATABASE_PATH: ':memory:', MEDIA_DIR: 'data/test-media', REQUIRE_ADMIN_MFA: 'true' },
    pool: 'forks',
    testTimeout: 30000,
  },
});
