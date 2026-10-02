import type { RegistrySearchItem } from "#compiled/shadcn-registry/index.js";
export declare function normalizeRegistryText(value: string): string;
export declare function printRegistrySearchResults(logger: {
    log(message: string): void;
}, result: {
    items: RegistrySearchItem[];
}, options: {
    json?: boolean;
    query: string | undefined;
    sections: readonly {
        label: string;
        items: RegistrySearchItem[];
        total: number;
        address(item: RegistrySearchItem): string;
    }[];
}): void;
