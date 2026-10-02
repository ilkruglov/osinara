export type SourceEdit = {
    readonly kind: "applied";
    readonly from: string;
    readonly to: string;
    readonly nextSource: string;
} | {
    readonly kind: "bail";
    readonly reason: string;
    readonly line: number;
};
/** Rewrites between a Gateway string model and an eve-owned `chatgpt()` call. */
export declare function applyModelSelectionToSource(sourceText: string, selection: string): Promise<SourceEdit>;
