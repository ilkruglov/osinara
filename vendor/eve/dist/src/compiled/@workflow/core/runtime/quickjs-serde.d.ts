/**
 * Host-side serialization for the QuickJS engine.
 *
 * Implements the workflow wire codec (format-prefixed devalue, identical to
 * `codec-devalue-vm.ts` / the node:vm engine's workflow-mode codec) as
 * host code operating on `JSValueHandle`s, using devalue 5.9's pluggable
 * operations (quickjs-wasi's host-side introspection primitives underneath).
 * The serde bundle previously evaluated inside the VM is gone: guest values
 * are read and built through handles, so no serializer code lives in — or
 * can be tampered with from — the guest realm.
 *
 * Side-effect discipline mirrors the node:vm engine's hardened codec
 * (serialization/hardened.ts):
 *
 * - classification is by engine brand (`classId` against boot-captured
 *   samples, `isError`, `isProxy`), never `instanceof` or
 *   `Symbol.toStringTag`;
 * - extraction goes through intrinsics captured at boot (before any user
 *   code runs) invoked with explicit receivers, or through own-property
 *   descriptor reads — patched prototypes and inherited accessors never
 *   run;
 * - the only guest code serialization can execute is the same code the
 *   previous in-VM codec executed by contract: a class's static
 *   `WORKFLOW_SERIALIZE` method, a step proxy's `__closureVarsFn`, and
 *   `WORKFLOW_USE_STEP` / `WORKFLOW_DESERIALIZE` on revival.
 *
 * Wire-format parity with the previous in-VM codec is REQUIRED and covered
 * by tests: event logs written by either codec must be readable by the
 * other (steps serialized by the node runtime feed VM revival and vice
 * versa).
 *
 * Hybrid value space: reducers return host shapes (plain objects, strings,
 * numbers) whose leaves may be guest handles — exactly how the node:vm
 * codec mixes host shapes with sandbox-realm leaves. Every stringify
 * operation therefore dispatches on `JSValueHandle` and falls back to
 * devalue's default host operations for host values. Parse operations
 * always build guest values, so the parse side is handle-only.
 */
import { JSValueHandle, type QuickJS } from '../_quickjs-wasi.js';
/**
 * Evaluate the serde capture root in a VM. Must run after the runtime
 * bootstrap and BEFORE any user code. The returned handle owns the
 * container; on the baseline-snapshot path its raw box pointer
 * (`handle.ptr`) is recorded next to the snapshot and re-adopted per
 * restored VM via {@link adoptSerdeRoot} — do NOT dispose the handle
 * before the snapshot is taken (the box must stay live in the memory
 * image).
 */
export declare function captureSerdeRoot(vm: QuickJS): JSValueHandle;
/**
 * Re-create the capture-root handle in a VM restored from a snapshot
 * taken while the exported root was alive, via quickjs-wasi's
 * snapshot-portable handle tokens (`importHandle` duplicates the
 * underlying value — the returned handle is independently owned and the
 * serde disposes it per restored VM). No guest code executes.
 */
export declare function adoptSerdeRoot(vm: QuickJS, token: number): JSValueHandle;
/**
 * Export the capture root as a snapshot-portable token to record next to
 * the baseline snapshot. The root handle must stay undisposed until the
 * snapshot is taken (its box — and the reference it holds — must be part
 * of the memory image).
 */
export declare function exportSerdeRoot(vm: QuickJS, root: JSValueHandle): number;
export interface QuickJSSerde {
    /** Serialize a guest value handle to format-prefixed wire bytes. */
    serialize(value: JSValueHandle): Uint8Array;
    /** Build a guest value in the VM from format-prefixed wire bytes. */
    deserialize(data: Uint8Array): JSValueHandle;
    /**
     * The reducer names this codec applies, in registration order. Exposed
     * so tests can assert exhaustiveness against the shared value-space
     * codec (codec-devalue-vm) — a reducer added there but not here would
     * otherwise silently round-trip values as plain objects.
     */
    reducerKeys: readonly string[];
    /** Reviver names, for the same exhaustiveness check. */
    reviverKeys: readonly string[];
    /**
     * Install `globalThis.process = { env: Object.freeze({...}) }` in the
     * VM through handles and boot-captured intrinsics only — no guest
     * source is evaluated, so a module-scope wrapper around JSON.parse /
     * Object.freeze cannot observe the injection. This matters on the
     * baseline-snapshot path, where env injection happens after user code
     * ran; evaluating guest source there would let patched globals see
     * (and perturb) it, diverging from the fresh path.
     */
    installProcessEnv(env: Record<string, string | undefined>): void;
    dispose(): void;
}
/**
 * Create the host-side serde for a VM. Must be called after the runtime
 * bootstrap has been evaluated (so bootstrap-installed globals are
 * capturable) and before the workflow bundle runs.
 */
export declare function createQuickJSSerde(vm: QuickJS, 
/**
 * Pre-captured serde root (baseline-snapshot path): the container
 * `captureSerdeRoot` created BEFORE user code, re-adopted from the
 * restored memory image via `adoptSerdeRoot`. When omitted, the root
 * is captured now — callers must guarantee no user code has run yet.
 * Either way, initialization below performs only plain-data property
 * reads and C-level classId reads on the container: NO guest code
 * executes here, so nothing user-patchable can observe or perturb it.
 */
capturedRoot?: JSValueHandle): QuickJSSerde;
//# sourceMappingURL=quickjs-serde.d.ts.map