const { updatePolicyFile } = await import(process.argv[2]);
const [path, prefix, count] = process.argv.slice(3);
const options = {
  empty: () => ({ names: [] }),
  parse: (value) => value,
};
const isLockTimeout = (error) =>
  String(error?.message).startsWith("Timed out waiting for tracing preference lock");
for (let index = 0; index < Number(count); index += 1) {
  for (;;) {
    try {
      await updatePolicyFile(path, options, (policy) => {
        policy.names = [...policy.names, `${prefix}-${index}`];
      });
      break;
    } catch (error) {
      if (!isLockTimeout(error)) throw error;
    }
  }
}
