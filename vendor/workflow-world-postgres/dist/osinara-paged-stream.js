/** Installed into the pinned Postgres World. Page reads are demand-driven, not whole-history loads. */
                                                                           
                        
                                                                             
                                                     
                                          
 
const STREAM_IDLE_POLL_MS = 1_000;

export function createPagedStream(source              , startIndex = 0)                             {
  if (!Number.isSafeInteger(startIndex)) throw new Error("AGENT_WORKFLOW_STREAM_INDEX_INVALID: Stream index must be a safe integer");
  let finished = false, initialized = false, revision = 0, skip = 0;
  let after                = null;
  let page                = [], offset = 0;
  let releaseWait                          ;
  const unsubscribe = source.subscribe(() => { revision++; releaseWait?.(); });
  const cleanup = () => {
    if (finished) return;
    finished = true; unsubscribe(); releaseWait?.(); page = [];
  };
  return new ReadableStream            ({
    async pull(controller) {
      try {
        if (!initialized) {
          const cursor = await source.initialize(startIndex);
          if (finished) return;
          after = cursor.after; skip = cursor.skip; initialized = true;
        }
        while (!finished) {
          if (offset < page.length) {
            const chunk = page[offset++] ; after = chunk.id;
            if (chunk.eof) { cleanup(); controller.close(); return; }
            if (skip > 0) { skip--; continue; }
            // Native abort readers are byte streams and transfer the backing ArrayBuffer.
            // pg's pooled Buffer is not transferable; keep the upstream copy-on-read contract.
            if (chunk.data.byteLength > 0) { controller.enqueue(new Uint8Array(chunk.data)); return; }
            continue;
          }
          const before = revision;
          const next = await source.page(after);
          if (finished) return;
          page = next; offset = 0;
          if (page.length > 0 || revision !== before) continue;
          // NOTIFY is a wake-up hint, not the source of truth. Poll also covers lost notifications.
          await new Promise      ((resolve) => {
            const timer = setTimeout(wake, STREAM_IDLE_POLL_MS);
            function wake() { clearTimeout(timer); releaseWait = undefined; resolve(); }
            releaseWait = wake;
          });
        }
      } catch (error) { cleanup(); controller.error(error); }
    },
    cancel: cleanup,
  }, { highWaterMark: 0 });
}
