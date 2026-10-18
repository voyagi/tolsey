import { defineConfig } from 'vitest/config';

const E2E_FILES = 'src/server/**/*.e2e.test.ts';
const CONFORMANCE_FILE = 'src/server/conformance.test.ts';
// The capture writes examples/ from the deployed Worker in real time, so only its own project, run by
// hand, ever starts it; npm test names its projects and never this one.
const CAPTURE_FILES = 'src/capture/**/*.capture.test.ts';

export default defineConfig({
  test: {
    environment: 'node',
    // Only code running in the Node process is counted: the workerd e2e leg adds nothing, and the
    // in-process conformance project is what covers src/server. The report directory is never
    // Stryker's .stryker-tmp, so a coverage run and a mutation run cannot collide.
    coverage: {
      provider: 'v8',
      include: [
        'src/contract/**/*.ts',
        'src/domain/**/*.ts',
        'src/store/**/*.ts',
        'src/server/**/*.ts',
        'src/client/**/*.ts',
        'src/ui/**/*.ts',
      ],
      exclude: ['src/**/*.test.ts', 'src/test-support/**'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
        // A glob does not inherit the top-level perFile, so it is set here explicitly.
        'src/domain/**/*.ts': { lines: 95, branches: 90, functions: 95, statements: 95, perFile: true },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'src/domain/**/*.test.ts',
            'src/contract/**/*.test.ts',
            'src/client/**/*.test.ts',
            'src/ui/**/*.test.ts',
            'src/capture/**/*.test.ts',
          ],
          exclude: [CAPTURE_FILES],
        },
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
      {
        extends: true,
        test: { name: 'capture', include: [CAPTURE_FILES], testTimeout: 600_000 },
      },
    ],
  },
});
