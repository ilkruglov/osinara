/** Authoring and distribution roots declared by an extension package. */
export interface ExtensionPackageRoots {
    /**
     * Authoring root. Optional so published packages can ship `dist` only;
     * `eve extension build` requires it.
     */
    readonly source?: string;
    readonly dist: string;
    /** Runtime packages the consuming application must preserve outside generated bundles. */
    readonly externalDependencies?: readonly string[];
}
/** Parses the strict `package.json#eve.extension` object contract. */
export declare function parseExtensionPackageRoots(value: unknown): ExtensionPackageRoots | null;
