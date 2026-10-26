/**
 * Order watch limits: how often an order is looked at, for how long, and when watching gives up.
 */
export const ORDER_WATCH_SERVICES = ["yandex_taxi", "yandex_lavka"] as const;
export type OrderWatchService = (typeof ORDER_WATCH_SERVICES)[number];

/** A car is found and arrives within minutes; a Lavka order moves in steps of several minutes. */
export const ORDER_WATCH_INTERVAL_MS: Readonly<Record<OrderWatchService, number>> = {
  yandex_lavka: 2 * 60_000,
  yandex_taxi: 60_000,
};
/** A ride or a delivery that has not ended by then is told so and no longer followed. */
export const ORDER_WATCH_DURATION_MS = 6 * 60 * 60_000;
/** Checks that failed in a row (a hung browser, the site not answering) before giving up. */
export const ORDER_WATCH_MAX_FAILURES = 10;
/** A placed Lavka order may take a moment to appear among the tracked ones. */
export const ORDER_WATCH_UNSEEN_GRACE_MS = 10 * 60_000;
/** Watches one minute tick looks at; each check is one or two browser calls of up to 40 s. */
export const ORDER_WATCH_BATCH_SIZE = 5;
/** Longer than the slowest check, so a crashed tick's watch is taken again, never twice at once. */
export const ORDER_WATCH_LEASE_MS = 5 * 60_000;
/**
 * A look at one order is cut off after this long; a taxi status that has to bring the tab back runs
 * up to eight browser commands.
 */
export const ORDER_WATCH_LOOK_DEADLINE_MS = 2 * 60_000;
/**
 * How long a check may hold the person's browser: the look's deadline plus one more command at its
 * 50 s bound and a browser recovery. A turn waits at most this long for a check that crashed.
 */
export const ORDER_WATCH_BROWSER_HOLD_MS = 4 * 60_000;
/** Finished watches are kept this long for diagnostics, then deleted. */
export const ORDER_WATCH_RETENTION_DAYS = 30;
