import { type Queue } from '@workflow/world';
import type { Pool } from 'pg';
import type { PostgresWorldConfig } from './config.js';
/**
 * The Postgres queue stores messages under one graphile-worker flow task.
 */
export type PostgresQueue = Queue & {
    start(): Promise<void>;
    close(): Promise<void>;
};
export declare function createQueue(config: PostgresWorldConfig, pool: Pool): PostgresQueue;
//# sourceMappingURL=queue.d.ts.map