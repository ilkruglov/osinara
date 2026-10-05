/**
 * Accounting of sandbox egress: one log line per connection, a daily byte budget per sandbox.
 *
 * Exports:
 * - `SANDBOX_EGRESS_DAILY_BYTES`: the default budget per client address and UTC day.
 * - `createEgressLedger`: `admit` before a connection, `record` when it closes.
 *
 * Key construct:
 * - The proxy logged only failures, so data leaving through it (a workspace, cookies) left no
 *   trace, and nothing bounded the volume (security review, 5 October 2026). Each connection is
 *   now logged with the client address, host, port, bytes each way and duration; the runner logs
 *   which sandbox has which address when it lays its network rules, so the two join. A client
 *   past its daily budget gets no new connection until the next UTC day. The address is the
 *   sandbox's on the egress network; a recreated container may get another one, which resets its
 *   count — the budget bounds a day's leak, it is not billing.
 */
export const SANDBOX_EGRESS_DAILY_BYTES = 2 * 1024 ** 3;
const MAX_TRACKED_CLIENTS = 5_000;

export interface EgressConnection {
  bytesDown: number;
  bytesUp: number;
  client: string;
  host: string;
  kind: "browserless" | "connect" | "http";
  ms: number;
  port: number;
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
  const usage = (client: string) => {
    const entry = days.get(client);
    return entry && entry.day === today() ? entry.bytes : 0;
  };
  return {
    /** False once the client spent its day's budget. */
    admit(client: string): boolean {
      if (usage(client) < dailyBytes) return true;
      log(JSON.stringify({ client, code: "SANDBOX_EGRESS_DAILY_LIMIT", dailyBytes }));
      return false;
    },
    record(connection: EgressConnection): void {
      const bytes = connection.bytesUp + connection.bytesDown;
      days.delete(connection.client);
      days.set(connection.client, { bytes: usage(connection.client) + bytes, day: today() });
      while (days.size > MAX_TRACKED_CLIENTS) days.delete(days.keys().next().value!);
      log(JSON.stringify({ code: "SANDBOX_EGRESS_CONNECTION", ...connection }));
    },
  };
}

export type EgressLedger = ReturnType<typeof createEgressLedger>;
