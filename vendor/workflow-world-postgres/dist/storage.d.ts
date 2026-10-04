import type { Storage } from '@workflow/world';
import { type Drizzle } from './drizzle/index.js';
export declare function createRunsStorage(drizzle: Drizzle): Storage['runs'];
export declare function createEventsStorage(drizzle: Drizzle): Storage['events'];
export declare function createHooksStorage(drizzle: Drizzle): Storage['hooks'];
export declare function createStepsStorage(drizzle: Drizzle): Storage['steps'];
/** Osinara fork: forgets every cached payload blob, as a fresh process would (tests only). */
export declare function resetPayloadBlobCacheForTest(): void;
//# sourceMappingURL=storage.d.ts.map