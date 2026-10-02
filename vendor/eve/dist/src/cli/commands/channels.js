import { listAuthoredChannels } from "#setup/scaffold/index.js";
async function runChannelsListCommand(t, n, r) {
  let i = await listAuthoredChannels(n.agentRoot);
  if (r.json) {
    t.log(JSON.stringify({ channels: i }, null, 2));
    return;
  }
  if (i.length === 0) {
    t.log("No channels defined. Run `eve add <channel>` to add one.");
    return;
  }
  for (let e of i) t.log(e);
}
export { runChannelsListCommand };
