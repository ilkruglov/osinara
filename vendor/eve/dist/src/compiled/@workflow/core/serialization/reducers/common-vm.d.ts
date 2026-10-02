/**
 * VM-compatible common reducers and revivers.
 *
 * Identical to common.ts but without Node.js dependencies:
 * - Uses native `btoa` / `atob` (provided by quickjs-wasi's base64
 *   extension, see `quickjs-assets.generated.ts`) instead of Buffer
 *   or pure-JS base64.
 * - Uses `instanceof Error` instead of `types.isNativeError()`.
 *
 * This module is safe to bundle into the QuickJS WASM VM.
 */
import type { Reducers, Revivers } from '../types.js';
export declare function getCommonReducers(): Partial<Reducers>;
export declare function getCommonRevivers(): Partial<Revivers>;
//# sourceMappingURL=common-vm.d.ts.map