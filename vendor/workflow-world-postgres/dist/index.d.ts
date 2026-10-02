import type { World } from '@workflow/world';
import type { PostgresWorldConfig } from './config.js';
export declare function createWorld(config?: PostgresWorldConfig): World & {
    start(): Promise<void>;
};
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';
//# sourceMappingURL=index.d.ts.map