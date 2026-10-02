export declare class Mutex {
    promise: Promise<unknown>;
    andThen<T>(fn: () => Promise<T> | T): Promise<T>;
}
export declare function compact<T extends object>(obj: T): { [key in keyof T]: null extends T[key] ? NonNullable<T[key]> | undefined : T[key]; };
//# sourceMappingURL=util.d.ts.map