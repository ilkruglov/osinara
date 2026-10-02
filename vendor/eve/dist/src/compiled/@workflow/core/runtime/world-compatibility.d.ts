import type { World } from '#compiled/@workflow/world/index.js';
type WorldSpecVersionMetadata = Pick<World, 'specVersion'>;
/**
 * Rejects a World this runtime cannot speak to.
 *
 * The accepted range is `[SPEC_VERSION_CURRENT, SPEC_VERSION_MAX_SUPPORTED]`.
 * Below the current version means an old World package paired with a new
 * runtime, which cannot serve the protocol this runtime speaks. Above the
 * ceiling means a World built against a newer spec than this runtime knows how
 * to read.
 *
 * Both bounds are the same version today, so this currently admits exactly one.
 * It stays written as a range because the two constants answer different
 * questions and come apart while a spec bump is staged: the ceiling rises when
 * this runtime learns to read the next version, the floor when that version
 * becomes the one Worlds stamp. An equality check against either constant alone
 * would reject a World during that window.
 */
export declare function assertWorldSupportsRuntimeProtocol(world: WorldSpecVersionMetadata): void;
export {};
//# sourceMappingURL=world-compatibility.d.ts.map