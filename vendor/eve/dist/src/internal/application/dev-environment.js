const EVE_DEV_ENV_FLAG = `EVE_DEV`;
function isEveDevEnvironment() {
  return process.env[EVE_DEV_ENV_FLAG] === `1`;
}
const EVE_EVALUATION_ENV_FLAG = `EVE_EVALUATION`,
  EVE_EVALUATION_RUN_ID_ENV = `EVE_EVALUATION_RUN_ID`;
function isEveEvaluationEnvironment() {
  return process.env[EVE_EVALUATION_ENV_FLAG] === `1`;
}
function resolveEveEvaluationRunId() {
  if (!isEveEvaluationEnvironment()) return;
  let e = process.env[EVE_EVALUATION_RUN_ID_ENV];
  return e === void 0 || e.length === 0 ? void 0 : e;
}
export {
  EVE_DEV_ENV_FLAG,
  EVE_EVALUATION_ENV_FLAG,
  EVE_EVALUATION_RUN_ID_ENV,
  isEveDevEnvironment,
  isEveEvaluationEnvironment,
  resolveEveEvaluationRunId,
};
