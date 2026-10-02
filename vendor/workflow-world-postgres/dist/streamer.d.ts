import type { Streamer } from '@workflow/world';
import { type Pool } from 'pg';
import { type Drizzle } from './drizzle/index.js';
/**
 * Subscribe to a PostgreSQL NOTIFY channel using a dedicated client created
 * from the pool's connection options. `channel` must be a trusted identifier.
 */
export declare const listenChannel: (pool: Pool, channel: string, onPayload: (payload: string) => Promise<void>) => Promise<{
    close: () => Promise<void>;
}>;
export type PostgresStreamer = Streamer & {
    /** Unlisten from the LISTEN subscription and release resources. */
    close(): Promise<void>;
};
export declare function createStreamer(pool: Pool, drizzle: Drizzle): PostgresStreamer;
//# sourceMappingURL=streamer.d.ts.map