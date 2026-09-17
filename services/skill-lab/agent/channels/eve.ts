import { eveChannel } from "eve/channels/eve";
import { verifyHttpBasic } from "eve/channels/auth";
import { job } from "../lib/job.js";
export default eveChannel({
  auth: (request) => {
    const password = process.env.SKILL_LAB_TOKEN;
    if (!password) return null;
    const result = verifyHttpBasic(request.headers.get("authorization"), { username: "lab", password });
    return result.ok ? result.sessionAuth : null;
  },
  onMessage(ctx, message) {
    if (ctx.eve.sessionId || message !== job().testCase.request) throw new Error("AGENT_SKILL_LAB_REQUEST_MISMATCH");
    return { auth: ctx.eve.caller };
  },
});
