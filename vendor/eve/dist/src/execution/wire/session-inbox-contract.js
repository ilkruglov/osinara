const SESSION_INBOX_WIRE_VERSIONS = [1],
  SESSION_INBOX_WIRE_VERSION =
    SESSION_INBOX_WIRE_VERSIONS[SESSION_INBOX_WIRE_VERSIONS.length - 1],
  SESSION_INBOX_WIRE_VERSION_METADATA_KEY = `sessionInboxWireVersion`;
function isSessionInboxWireVersion(t) {
  return SESSION_INBOX_WIRE_VERSIONS.some((e) => e === t);
}
var SessionInboxWireError = class extends Error {
  constructor(e) {
    (super(e), (this.name = `SessionInboxWireError`));
  }
};
export {
  SESSION_INBOX_WIRE_VERSION,
  SESSION_INBOX_WIRE_VERSIONS,
  SESSION_INBOX_WIRE_VERSION_METADATA_KEY,
  SessionInboxWireError,
  isSessionInboxWireVersion,
};
