var SessionStateCursor = class {
  currentSerializedContext;
  currentSessionState;
  constructor(e) {
    ((this.currentSerializedContext = e.serializedContext),
      (this.currentSessionState = e.sessionState));
  }
  get serializedContext() {
    return this.currentSerializedContext;
  }
  get sessionState() {
    return this.currentSessionState;
  }
  adoptState(e) {
    ((this.currentSerializedContext =
      e.serializedContext ?? this.currentSerializedContext),
      (this.currentSessionState = e.sessionState ?? this.currentSessionState));
  }
};
export { SessionStateCursor };
