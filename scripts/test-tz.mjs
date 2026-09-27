// Runs the unit, store and conformance projects under host zones that are NOT the kitchen's.
// A host in the kitchen's own zone hides a bug that reads the host clock (RESEARCH Pitfall 5), so
// the kitchen's zone is deliberately absent here. TZ is set in the child's env, never in a
// package.json script: cmd on Windows does not take that syntax.
import { spawnSync } from 'node:child_process';

const ZONES = ['UTC', 'Europe/Amsterdam'];
const VITEST = 'node_modules/vitest/vitest.mjs';
const ARGS = [VITEST, 'run', '--project', 'unit', '--project', 'store', '--project', 'conformance'];
const TIMEOUT_MS = 20 * 60 * 1000;
const ZONE_PROBE = 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)';
const SAME_ZONE = { UTC: ['UTC', 'Etc/UTC'] };

// Git Bash has been seen to drop TZ=Europe/Amsterdam on its way to Node, so the child is asked
// which zone it actually runs in before a green run is believed.
function zoneTookEffect(zone) {
  const probe = spawnSync(process.execPath, ['-e', ZONE_PROBE], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
  const seen = probe.status === 0 ? probe.stdout.trim() : `probe exit ${probe.status}`;
  const accepted = SAME_ZONE[zone] ?? [zone];
  if (accepted.includes(seen)) return true;
  console.error(`[test-tz] ${zone}: the child ran in ${seen}, so TZ did not reach it`);
  return false;
}

function runIn(zone) {
  if (!zoneTookEffect(zone)) return 1;
  const result = spawnSync(process.execPath, ARGS, {
    stdio: 'inherit',
    env: { ...process.env, TZ: zone },
    timeout: TIMEOUT_MS,
  });
  // A timeout kill sets both error (ETIMEDOUT) and signal, so it is named before either.
  if (result.error && result.error.code === 'ETIMEDOUT') {
    console.error(`[test-tz] ${zone}: timed out after ${TIMEOUT_MS / 60000} min and was killed`);
    return 1;
  }
  if (result.error) {
    console.error(`[test-tz] ${zone}: could not run vitest: ${result.error.message}`);
    return 1;
  }
  if (result.status === null) {
    console.error(`[test-tz] ${zone}: killed by signal ${result.signal}`);
    return 1;
  }
  return result.status;
}

for (const zone of ZONES) {
  const status = runIn(zone);
  console.log(`[test-tz] ${zone}: exit ${status}`);
  if (status !== 0) {
    console.error(`[test-tz] failed under TZ=${zone}; the remaining zones did not run`);
    process.exit(status);
  }
}
