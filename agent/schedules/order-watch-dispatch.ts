/**
 * Eve minute tick of order watches: taxi rides and Lavka orders the person is told about as they move on.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueOrderWatches } from "../lib/order-watch/order-watch-production.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchDueOrderWatches());
  },
});
