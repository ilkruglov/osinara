/**
 * Strip the trailing `//# sourceMappingURL=data:…` comment from a JS
 * bundle. Returns the input unchanged if no trailing inline map is
 * present.
 *
 * Use this on the host side before evaluating workflow bundles inside
 * the QuickJS VM — the inline map can account for several MB of bundle
 * text (measured ~30%+ of VM heap bytes on the example workbench's
 * bundle), and the VM never needs it; only host-side `remapErrorStack`
 * reads the map (and it can do so against the original, unstripped
 * string).
 *
 * Implemented as a linear `lastIndexOf` + character scan rather than a
 * regex: on webpack dev-server bundles (tens of MB, with hundreds of
 * per-module inline map comments embedded in eval strings) a
 * `String.replace` regex over the bundle blows V8's call stack
 * ("RangeError: Maximum call stack size exceeded"), wedging every
 * workflow invocation on that framework.
 */
export declare function stripInlineSourceMap(workflowCode: string): string;
/**
 * Remaps an error stack trace using inline source maps to show original source locations.
 *
 * Degrades gracefully when the bundle has no inline source map (e.g. production
 * builds, where maps are off by default): the original stack is returned
 * unchanged. A cheap `filename` presence check skips all work when no frame
 * references the workflow file, and parsed source maps are memoized per bundle.
 *
 * @param stack - The error stack trace to remap
 * @param filename - The workflow filename to match in stack frames
 * @param workflowCode - The workflow bundle code containing inline source maps
 * @returns The remapped stack trace with original source locations
 */
export declare function remapErrorStack(stack: string, filename: string, workflowCode: string): string;
//# sourceMappingURL=source-map.d.ts.map