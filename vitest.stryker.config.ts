import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import base from './vitest.config.ts';

// The mutation step's own Vitest config. Stryker's command runner reruns this suite once for every
// mutant, about two thousand times in a full run, so it keeps that suite as light as the results
// allow:
// - The unit and conformance projects only, the pair the mutation step has always run.
// - Without src/server/deploy-gates.test.ts. It runs the deploy scripts' selftests in child
//   processes and imports no mutated file, so it can never kill a mutant, only fail for some other
//   reason and be counted as a kill. A run that --bail stopped also left its children running.
// - In worker threads, at most two per run: no child process per test file, and the four runs
//   Stryker keeps going at once (stryker.config.json) stay near half of a 16-thread machine.
const MUTATION_PROJECTS = ['unit', 'conformance'];
const NEVER_KILLS = 'src/server/deploy-gates.test.ts';

function isInlineProject(project: unknown): project is TestProjectInlineConfiguration {
  return typeof project === 'object' && project !== null && 'test' in project;
}

const projects = (base.test?.projects ?? [])
  .filter(isInlineProject)
  .filter((project) => MUTATION_PROJECTS.includes(String(project.test?.name)))
  .map((project) => ({
    ...project,
    test: { ...project.test, exclude: [...(project.test?.exclude ?? configDefaults.exclude), NEVER_KILLS] },
  }));

// A renamed or removed project must stop the run, never leave it mutating against fewer tests.
if (projects.length !== MUTATION_PROJECTS.length) {
  throw new Error(
    `vitest.stryker.config.ts expects the ${MUTATION_PROJECTS.join(' and ')} projects in vitest.config.ts ` +
      `and found ${projects.length} of them. Rename the entries in MUTATION_PROJECTS to match.`,
  );
}

export default defineConfig({ ...base, test: { ...base.test, pool: 'threads', maxWorkers: 2, projects } });
