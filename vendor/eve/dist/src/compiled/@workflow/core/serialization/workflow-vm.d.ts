/**
 * Host-side reference implementation of the QuickJS engine's workflow-mode
 * wire codec.
 *
 * The QuickJS engine serializes through handles on the host
 * (runtime/quickjs-serde.ts); this module is the value-space equivalent of
 * that codec and is used by tests to build wire fixtures and assert
 * byte-level parity. It has NO Node.js dependencies (no Buffer, no
 * node:util), which is also what made it bundleable into the VM before the
 * serde moved host-side.
 *
 * Produces and consumes the same wire format as the Node.js workflow.ts —
 * format-prefixed devalue data ("devl" + devalue.stringify output).
 */
/**
 * Serialize a value to format-prefixed bytes.
 *
 * @param value - The value to serialize
 * @returns Uint8Array with "devl" prefix + devalue payload
 */
export declare function serialize(value: unknown): Uint8Array;
/**
 * Deserialize format-prefixed bytes back to a value.
 *
 * @param data - Uint8Array with format prefix, or legacy non-binary data
 * @returns The deserialized value
 */
export declare function deserialize(data: Uint8Array | unknown): unknown;
//# sourceMappingURL=workflow-vm.d.ts.map