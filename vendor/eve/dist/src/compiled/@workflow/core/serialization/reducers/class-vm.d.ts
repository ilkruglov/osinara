/**
 * VM-compatible copy: identical semantics to class.ts before the host-side
 * hardening (#3257) made that module depend on `serialization/hardened.ts`
 * (which imports `node:util` and captures host intrinsics — meaningless
 * and unbundleable inside the QuickJS VM, where the codec already runs in
 * the guest realm). The host/guest boundary hardening for the QuickJS
 * engine lands with the host-side serde (#3263), which retires this
 * bundle entirely. Wire format is identical to the hardened host version.
 */
/**
 * Reducers and revivers for custom class serialization.
 *
 * Handles:
 * - Class: class constructors with a `classId` property
 * - Instance: instances of classes with custom WORKFLOW_SERIALIZE/DESERIALIZE methods
 */
import type { Reducers, Revivers } from '../types.js';
export declare function getClassReducers(): Partial<Reducers>;
export declare function getClassRevivers(global?: Record<string, any>): Partial<Revivers>;
//# sourceMappingURL=class-vm.d.ts.map