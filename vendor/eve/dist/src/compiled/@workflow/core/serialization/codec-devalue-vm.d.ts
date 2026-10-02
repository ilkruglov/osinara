/**
 * VM-compatible devalue codec.
 *
 * Same as codec-devalue.ts but uses VM-compatible reducers/revivers
 * (no Node.js Buffer, no node:util). Safe to bundle into the QuickJS VM.
 */
import type { Codec } from './codec.js';
/**
 * The workflow-mode reducer/reviver key sets — exported for the QuickJS
 * host serde's exhaustiveness test (quickjs-serde.test.ts), which pins
 * that the handle-space codec implements exactly these.
 */
export declare function getWorkflowModeReducerKeys(): string[];
export declare function getWorkflowModeReviverKeys(): string[];
export declare const devalueVmCodec: Codec;
//# sourceMappingURL=codec-devalue-vm.d.ts.map