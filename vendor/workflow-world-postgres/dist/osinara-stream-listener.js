/**
 * LISTEN subscription of the Workflow stream notifications that outlives a dropped connection.
 *
 * Exports:
 * - `createStreamListener`: connects a dedicated client, LISTENs on the channel and hands every
 *   payload to `onPayload`; when the connection ends or errors it reconnects with a growing delay
 *   and logs the loss and the recovery. `close` stops both.
 *
 * Key construct:
 * - The upstream listener (Postgres World 5.0.0-beta.35) never reconnected: after a Postgres
 *   restart only the readers' idle poll woke anyone, and that poll is now thirty seconds
 *   (4 October 2026) because at five it kept Postgres busy with empty reads under load.
 */

                                 
                           
                       
                                                                                                       
                                        
                                                                                                                   
 

                                 
                         
 

export const STREAM_LISTENER_RETRY_MS = 1_000;
export const STREAM_LISTENER_MAX_RETRY_MS = 30_000;

export async function createStreamListener(input   
                  
                                
                               
                           
                                                
                        
                                        
 )                          {
  const log = input.log ?? ((line) => console.warn(line));
  const sleep = input.sleep ?? ((ms) => new Promise      ((resolve) => setTimeout(resolve, ms)));
  const baseDelay = input.retryDelayMs ?? STREAM_LISTENER_RETRY_MS;
  const maxDelay = input.maxRetryDelayMs ?? STREAM_LISTENER_MAX_RETRY_MS;
  let closed = false;
  let client                        = null;
  let detach                      = null;
  let reconnecting                       = null;

  const onNotification = (message                      ) => {
    input.onPayload(message.payload ?? "").catch(() => {});
  };

  async function open()                {
    const next = input.connect();
    try {
      await next.connect();
      await next.query(`LISTEN ${input.channel}`);
    } catch (error) {
      await next.end().catch(() => {});
      throw error;
    }
    const onLost = (reason         ) => {
      if (detach) detach();
      void reconnect(reason);
    };
    next.on("notification", onNotification);
    next.on("error", onLost);
    next.on("end", onLost);
    client = next;
    detach = () => {
      next.removeListener("notification", onNotification);
      next.removeListener("error", onLost);
      next.removeListener("end", onLost);
      detach = null;
      client = null;
    };
  }

  async function reconnect(reason         )                {
    if (closed || reconnecting) return;
    reconnecting = (async () => {
      log(JSON.stringify({
        code: "AGENT_WORKFLOW_STREAM_LISTENER_LOST",
        error: reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "connection ended",
      }));
      let delay = baseDelay;
      let attempts = 0;
      while (!closed) {
        await sleep(delay);
        if (closed) return;
        attempts += 1;
        try {
          await open();
          log(JSON.stringify({ code: "AGENT_WORKFLOW_STREAM_LISTENER_RECONNECTED", attempts }));
          return;
        } catch (error) {
          log(JSON.stringify({
            attempts,
            code: "AGENT_WORKFLOW_STREAM_LISTENER_RETRY_FAILED",
            error: error instanceof Error ? error.message : String(error),
          }));
          delay = Math.min(maxDelay, delay * 2);
        }
      }
    })().finally(() => { reconnecting = null; });
    await reconnecting;
  }

  await open();
  return {
    async close() {
      closed = true;
      const current = client;
      if (detach) detach();
      if (!current) return;
      try {
        await current.query(`UNLISTEN ${input.channel}`);
      } finally {
        await current.end().catch(() => {});
      }
    },
  };
}
