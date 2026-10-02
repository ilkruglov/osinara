import { createSession } from "#channel/session.js";
import {
  SCHEDULE_APP_AUTH,
  SCHEDULE_APP_AUTH as SCHEDULE_APP_AUTH$1,
} from "#channel/schedule-auth.js";
import {
  createCrossChannelToFn,
  toCrossChannelTargets,
} from "#channel/cross-channel-receive.js";
import { expectFunction } from "#internal/authored-module.js";
const SCHEDULE_ADAPTER_KIND = `schedule`,
  SCHEDULE_ADAPTER = { kind: SCHEDULE_ADAPTER_KIND };
var ScheduleDispatcher = class {
  runtime;
  channels;
  constructor(e) {
    ((this.runtime = e.runtime), (this.channels = e.channels));
  }
  async trigger(e) {
    let t = [],
      a = [],
      o = createCrossChannelToFn(
        this.runtime,
        toCrossChannelTargets(this.channels),
      ),
      s = {
        appAuth: SCHEDULE_APP_AUTH$1,
        to(e, n) {
          let r = o(e, n);
          return {
            async send(e, n) {
              let i = await r.send(e, n);
              return (t.push(i), i);
            },
          };
        },
        waitUntil(e) {
          a.push(e);
        },
      };
    if (e.run) await e.run(s);
    else if (e.markdown !== void 0) {
      let n = await this.runMarkdown(e.markdown);
      t.push(n);
    } else
      throw Error(
        `Schedule "${e.scheduleId}" has neither "run" nor "markdown" — at least one must be set.`,
      );
    return { sessions: t, waitUntilTasks: a };
  }
  async runMarkdown(t) {
    return createSession(
      (
        await this.runtime.createSession({
          adapter: SCHEDULE_ADAPTER,
          auth: SCHEDULE_APP_AUTH$1,
          input: { message: t },
          mode: `task`,
        })
      ).sessionId,
      this.runtime,
    );
  }
};
function expectScheduleRun(e, t, n) {
  let r = e;
  if (typeof r != `object` || !r)
    throw Error(
      `Schedule export "${n ?? `default`}" from "${t}" must be an object.`,
    );
  return expectFunction(
    r.run,
    `Expected the schedule export "${n ?? `default`}" from "${t}" to export a \`run\` handler function.`,
  );
}
export {
  SCHEDULE_ADAPTER,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_APP_AUTH,
  ScheduleDispatcher,
  expectScheduleRun,
};
