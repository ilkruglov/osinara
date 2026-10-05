/**
 * Accounting of sandbox egress: one log line per connection, a daily byte budget per sandbox.
 *
 * Exports:
 * - `SANDBOX_EGRESS_DAILY_BYTES`: the default budget per client address and UTC day.
 * - `createEgressLedger`: `open` a meter before a connection, `add` its bytes as they flow,
 *   `close` it once.
 *
 * Key construct:
 * - The proxy logged only failures, so data leaving through it (a workspace, cookies) left no
 *   trace, and nothing bounded the volume (security review, 5 October 2026). Each connection is
 *   now logged with the client address, host, port, bytes each way and duration; the runner logs
 *   which sandbox has which address when it lays its network rules, so the two join. Bytes count
 *   the moment they pass, into one total per client and day, so a long tunnel and many parallel
 *   connections spend the same budget (Codex review, 5 October 2026); past it, `add` answers
 *   false and the proxy closes the connection, and `open` refuses new ones until the next UTC day.
 *   The address is the sandbox's on the egress network; a recreated container may get another
 *   one, which resets its count — the budget bounds a day's leak, it is not billing.
 */
export const SANDBOX_EGRESS_DAILY_BYTES = 2 * 1024 ** 3;
const MAX_TRACKED_CLIENTS = 5_000;

export interface EgressTarget {
  host: string;
  kind: "browserless" | "connect" | "http";
  port: number;
}

export interface EgressMeter {
  /** Counts bytes that passed; false once the client's day is over budget. */
  add(direction: "down" | "up", bytes: number): boolean;
  /** Logs the connection; later calls do nothing. */
  close(target: EgressTarget): void;
}

export function createEgressLedger(input: {
  dailyBytes?: number;
  log?: (line: string) => void;
  now?: () => number;
} = {}) {
  const dailyBytes = input.dailyBytes ?? SANDBOX_EGRESS_DAILY_BYTES;
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.info(line));
  const days = new Map<string, { bytes: number; day: number }>();
  const today = () => Math.floor(now() / 86_400_000);
  const spent = (client: string) => {
    const entry = days.get(client);
    return entry && entry.day === today() ? entry.bytes : 0;
  };
  const spend = (client: string, bytes: number): number => {
    const total = spent(client) + bytes;
    // Re-inserted, so the oldest entry is the least recently active client.
    days.delete(client);
    days.set(client, { bytes: total, day: today() });
    while (days.size > MAX_TRACKED_CLIENTS) days.delete(days.keys().next().value!);
    return total;
  };
  const refuse = (client: string) => log(JSON.stringify({ client, code: "SANDBOX_EGRESS_DAILY_LIMIT", dailyBytes }));
  return {
    /** A meter for a new connection, or null once the client spent its day's budget. */
    open(client: string): EgressMeter | null {
      if (spent(client) >= dailyBytes) {
        refuse(client);
        return null;
      }
      const startedAt = now();
      let bytesUp = 0;
      let bytesDown = 0;
      let over = false;
      let closed = false;
      return {
        add(direction, bytes) {
          if (direction === "up") bytesUp += bytes;
          else bytesDown += bytes;
          if (spend(client, bytes) < dailyBytes) return true;
          if (!over) refuse(client);
          over = true;
          return false;
        },
        close(target) {
          if (closed) return;
          closed = true;
          log(JSON.stringify({ code: "SANDBOX_EGRESS_CONNECTION", bytesDown, bytesUp, client, ...target, ms: now() - startedAt }));
        },
      };
    },
  };
}

export type EgressLedger = ReturnType<typeof createEgressLedger>;
