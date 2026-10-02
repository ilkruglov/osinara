var SetupPrerequisiteRequired = class extends Error {
  prerequisite;
  constructor(e) {
    (super(e.message),
      (this.name = `SetupPrerequisiteRequired`),
      (this.prerequisite = e));
  }
};
export { SetupPrerequisiteRequired };
