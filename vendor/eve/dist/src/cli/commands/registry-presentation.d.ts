import type { RegistrySearchItem } from "#compiled/shadcn-registry/index.js";
import { type RegistrySearchMetadata } from "./registry-metadata.js";
export interface RegistrySearchPresentationItem extends RegistrySearchMetadata {
    address: string;
    item: RegistrySearchItem;
}
export interface RegistrySearchPresentationSection {
    label: string;
    items: RegistrySearchPresentationItem[];
    total: number;
}
export declare function normalizeRegistryText(value: string): string;
export declare function printRegistrySearchResults(logger: {
    log(message: string): void;
}, input: {
    json?: unknown;
    query: string | undefined;
    sections: readonly RegistrySearchPresentationSection[];
}): void;
export declare function registryViewText(item: string, input: unknown): string;
