/** Regression coverage for fresh-install and updater-owned file permissions. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionOperationalCommands } from './production-operational-commands.js';

const state = vi.hoisted(() => ({ modes: new Map<string, number>(), uid: 0, symlink: false }));
const modelConfig = readFileSync(new URL('../../config/agent-model-providers.json', import.meta.url));
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async (path: string) => ({
    uid: state.uid, gid: 0, mode: state.modes.get(path) ?? 0o600,
    isFile: () => true, isSymbolicLink: () => state.symlink,
  })),
  realpath: vi.fn(async (path: string) => path),
  readFile: vi.fn(async (path: string) => {
    if (path.endsWith('agent-model-providers.json')) return modelConfig;
    if (path.endsWith('osinara-deployment.json')) return Buffer.from('{"version":"1.0.0"}');
    if (path.endsWith('/tls/.env')) return Buffer.from('OSINARA_HOSTNAME=bot.example.com\n');
    return Buffer.from('{}');
  }),
}));
vi.mock('./process-runner.js', () => ({ runHostCommand: vi.fn(async () => Buffer.from('')) }));

beforeEach(() => {
  state.modes.clear(); state.uid = 0; state.symlink = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const response = new Response('ok');
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

const nonSecretFiles = ['osinara-deployment.json', 'agent-model-providers.json', 'compose.installation.json', 'tls/compose.tls.yaml'];
describe('maintenance after an update', () => {
  it.each([0o600, 0o644])('accepts root-owned configuration mode %i in status and doctor', async mode => {
    for (const name of nonSecretFiles) state.modes.set(`/opt/osinara/${name}`, mode);
    const commands = createProductionOperationalCommands();
    await expect(commands.status()).resolves.toMatchObject({ code: 'OSINARA_STATUS_OK', version: '1.0.0' });
    await expect(commands.doctor()).resolves.toMatchObject({ code: 'OSINARA_DOCTOR_OK' });
  });
  it.each([0o664, 0o666, 0o755])('rejects writable or executable configuration mode %i', async mode => {
    state.modes.set('/opt/osinara/osinara-deployment.json', mode);
    await expect(createProductionOperationalCommands().status()).rejects.toMatchObject({ code: 'OSINARA_OPERATION_FILE_INVALID' });
  });
  it('still rejects a world-readable secret file', async () => {
    state.modes.set('/opt/osinara/.env', 0o644);
    await expect(createProductionOperationalCommands().doctor()).rejects.toMatchObject({ code: 'OSINARA_OPERATION_FILE_INVALID' });
  });
  it.each(['owner', 'symlink'])('rejects invalid %s even with private permissions', async problem => {
    if (problem === 'owner') state.uid = 1000;
    else state.symlink = true;
    await expect(createProductionOperationalCommands().status()).rejects.toMatchObject({ code: 'OSINARA_OPERATION_FILE_INVALID' });
  });
});
