function applicationCommand(e, t, n = () => !0) {
  return e.hook(`preAction`, async (e, r) => {
    n(r) && (await t.resolve());
  });
}
export { applicationCommand };
