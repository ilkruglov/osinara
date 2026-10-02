import { InvalidArgumentError } from "#compiled/commander/index.js";
function parseSetupAnswer(e, t = {}) {
  let n = e.indexOf(`=`);
  if (n < 1) throw new InvalidArgumentError(`Expected "key=value".`);
  let r = e.slice(0, n).trim(),
    i = e.slice(n + 1);
  if (r.length === 0)
    throw new InvalidArgumentError(`Setup answer key cannot be empty.`);
  let a;
  try {
    a = JSON.parse(i);
  } catch {
    throw new InvalidArgumentError(
      `Setup answer for "${r}" must be JSON; quote string values, for example '${r}="value"'.`,
    );
  }
  return { ...t, [r]: a };
}
export { parseSetupAnswer };
