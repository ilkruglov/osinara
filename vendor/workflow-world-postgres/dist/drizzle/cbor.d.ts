export declare function Cbor<T>(): {
    (): import("drizzle-orm/pg-core").PgCustomColumnBuilder<{
        name: "";
        dataType: "custom";
        columnType: "PgCustomColumn";
        data: T;
        driverParam: Buffer<ArrayBufferLike>;
        enumValues: undefined;
    }>;
    <TConfig extends Record<string, any>>(fieldConfig?: TConfig | undefined): import("drizzle-orm/pg-core").PgCustomColumnBuilder<{
        name: "";
        dataType: "custom";
        columnType: "PgCustomColumn";
        data: T;
        driverParam: Buffer<ArrayBufferLike>;
        enumValues: undefined;
    }>;
    <TName extends string>(dbName: TName, fieldConfig?: unknown): import("drizzle-orm/pg-core").PgCustomColumnBuilder<{
        name: TName;
        dataType: "custom";
        columnType: "PgCustomColumn";
        data: T;
        driverParam: Buffer<ArrayBufferLike>;
        enumValues: undefined;
    }>;
};
/**
 * Adds a `{key}Json` property to the given type V, representing a key that was
 * migrated to CBOR and can contain a previous JSONB representation.
 *
 * We migrated from JSONB to CBOR, but to avoid breaking changes in the codebase,
 * we keep both representations in the database, and therefore we need to extend
 * the types accordingly.
 */
export type Cborized<V extends object, K extends keyof V> = V & {
    [key in `${Extract<K, string>}Json`]: unknown;
};
//# sourceMappingURL=cbor.d.ts.map