import { defineConfig } from 'vitest/config';

const E2E_FILES = 'src/server/**/*.e2e.test.ts';
const CONFORMANCE_FILE = 'src/server/conformance.test.ts';

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/domain/**/*.test.ts', 'src/contract/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'store', include: ['src/store/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'conformance',
          include: ['src/server/**/*.test.ts'],
          exclude: [E2E_FILES],
          provide: { target: 'in-process' },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: [E2E_FILES, CONFORMANCE_FILE],
          provide: { target: 'workerd' },
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: { name: 'deployed', include: [CONFORMANCE_FILE], provide: { target: 'deployed' } },
      },
    ],
  },
});
