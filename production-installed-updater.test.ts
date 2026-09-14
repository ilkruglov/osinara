import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });

describe('installed Mia updater', () => {
  it('uses the existing installation files without a legacy current symlink', () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const directory = mkdtempSync(resolve('.tmp/installed-updater-'));
    directories.push(directory);
    writeFileSync(join(directory, 'compose.installation.json'), '{}');
    writeFileSync(join(directory, 'release.env'), '');
    writeFileSync(join(directory, 'osinara-deployment.json'), '{}');
    const common = readFileSync('scripts/production-deploy/common.sh', 'utf8')
      .replace('readonly BASE_DIR="/opt/osinara"', `readonly BASE_DIR=${quote(directory)}`);
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${common}\nset_current_release_paths\nprintf '%s\\n' "$CURRENT_COMPOSE" "$CURRENT_ENV"`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([join(directory, 'compose.installation.json'), join(directory, 'release.env')]);
  });

  it('recognizes persistent volumes in the installation JSON', () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const directory = mkdtempSync(resolve('.tmp/installed-updater-'));
    directories.push(directory);
    const path = join(directory, 'compose.json');
    writeFileSync(path, JSON.stringify({ volumes: { 'workspace-data': { name: 'osinara-production-workspace-data' } } }));
    const result = spawnSync('bash', ['-c', `set -euo pipefail\nsource scripts/production-deploy/backup.sh\ncompose_declares_volume ${quote(path)} workspace-data\n! compose_declares_volume ${quote(path)} missing`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('ships one update path without historical provider and Workflow bridges', () => {
    const main = readFileSync('scripts/production-deploy.sh', 'utf8');
    expect(main).not.toContain('bridge.sh');
    expect(main).not.toMatch(/provision_v0|validate_v0|prepare_v0160/);
    expect(main).not.toContain('--initial');
    expect(main.indexOf('stop_current_services\n')).toBeLessThan(main.indexOf('create_postgres_backup\n'));
  });
});
