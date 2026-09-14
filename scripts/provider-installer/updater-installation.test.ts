import { describe, expect, it, vi } from 'vitest';
import { activateInstalledUpdater, stageInstalledUpdater } from './updater-installation.js';

const names = ['production-deploy.sh', 'production-deploy/common.sh', 'production-deploy/database.sh', 'production-deploy/release.sh', 'production-deploy/backup.sh', 'osinara-deploy.service', 'osinara-deploy.timer', 'LICENSE', 'NOTICE'];
const files = (): Map<string, Buffer> => new Map(names.map((name) => [`installation/${name}`, Buffer.from(name)]));

describe('Mia updater installation', () => {
  it('stages only fixed root-owned paths and leaves the timer inactive', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn().mockResolvedValue(undefined);
    await stageInstalledUpdater(files(), { mkdir, write });
    expect(mkdir.mock.calls).toEqual([['/opt/osinara/bin', 0o750], ['/opt/osinara/bin/production-deploy', 0o750]]);
    expect(write).toHaveBeenCalledWith('/opt/osinara/bin/production-deploy.sh', Buffer.from('production-deploy.sh'), 0o750);
    expect(write).toHaveBeenCalledWith('/opt/osinara/bin/production-deploy/release.sh', Buffer.from('production-deploy/release.sh'), 0o640);
    expect(write.mock.calls.every(([path]) => path.startsWith('/opt/osinara/'))).toBe(true);
  });
  it('rejects missing controller bytes before creating directories', async () => {
    const archive = files(); archive.delete('installation/production-deploy/release.sh');
    const mkdir = vi.fn(), write = vi.fn();
    await expect(stageInstalledUpdater(archive, { mkdir, write })).rejects.toMatchObject({ code: 'OSINARA_INSTALL_BUNDLE_ENTRY_INVALID' });
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it('activates the timer only after both validated unit files have been installed', async () => {
    const events: string[] = [];
    await activateInstalledUpdater(files(), {
      write: async (path) => { events.push(path); },
      run: async (args) => { events.push(args.join(' ')); },
    });
    expect(events).toEqual(['/etc/systemd/system/osinara-deploy.service', '/etc/systemd/system/osinara-deploy.timer', 'daemon-reload', 'enable --now osinara-deploy.timer']);
  });
});
