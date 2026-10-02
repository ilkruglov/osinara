import type { Pool } from 'pg';
import * as Schema from './schema.js';
export { Schema };
export type Drizzle = ReturnType<typeof createClient>;
export declare function createClient(pool: Pool): import("drizzle-orm/node-postgres").NodePgDatabase<typeof Schema> & {
    $client: Pool;
};
//# sourceMappingURL=index.d.ts.map