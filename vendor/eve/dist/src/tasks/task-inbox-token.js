function readTaskIdFromInboxToken(e) {
  return /^task:(task_[^:]+):[a-f0-9]{32}$/.exec(e)?.[1];
}
export { readTaskIdFromInboxToken };
