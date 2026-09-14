/** Fixed root-owned updater files; activation happens only at installation commit. */
import { InstallerError } from './errors.js';

const BASE = '/opt/osinara';
const CONTROLLER = ['production-deploy.sh', 'production-deploy/common.sh', 'production-deploy/database.sh', 'production-deploy/release.sh', 'production-deploy/backup.sh'] as const;
const UNITS = ['osinara-deploy.service', 'osinara-deploy.timer'] as const;
type Write = (path: string, bytes: Buffer, mode: number) => Promise<void>;

function requireBytes(files: ReadonlyMap<string, Buffer>, name: string): Buffer {
  const value = files.get(`installation/${name}`);
  if (!value?.length) throw new InstallerError('OSINARA_INSTALL_BUNDLE_ENTRY_INVALID', `В архиве отсутствует ${name}`);
  return value;
}

export async function stageInstalledUpdater(
  files: ReadonlyMap<string, Buffer>,
  dependencies: { mkdir(path: string, mode: number): Promise<void>; write: Write },
): Promise<void> {
  for (const name of [...CONTROLLER, ...UNITS, 'LICENSE', 'NOTICE']) requireBytes(files, name);
  await dependencies.mkdir(`${BASE}/bin`, 0o750);
  await dependencies.mkdir(`${BASE}/bin/production-deploy`, 0o750);
  for (const name of CONTROLLER) {
    await dependencies.write(`${BASE}/bin/${name}`, requireBytes(files, name), name === 'production-deploy.sh' ? 0o750 : 0o640);
  }
  for (const name of [...UNITS, 'LICENSE', 'NOTICE']) {
    await dependencies.write(`${BASE}/bin/${name}`, requireBytes(files, name), 0o644);
  }
}

export async function activateInstalledUpdater(
  files: ReadonlyMap<string, Buffer>,
  dependencies: { write: Write; run(args: string[]): Promise<void> },
): Promise<void> {
  for (const name of UNITS) requireBytes(files, name);
  for (const name of UNITS) {
    await dependencies.write(`/etc/systemd/system/${name}`, requireBytes(files, name), 0o644);
  }
  await dependencies.run(['daemon-reload']);
  await dependencies.run(['enable', '--now', 'osinara-deploy.timer']);
}
