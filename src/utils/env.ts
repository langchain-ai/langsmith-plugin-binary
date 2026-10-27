export function withoutEnvVariables<T>(names: readonly string[], run: () => T): T {
  const hidden = names.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  for (const [name] of hidden) delete process.env[name];
  try {
    return run();
  } finally {
    for (const [name, value] of hidden) process.env[name] = value;
  }
}

export function withEnvVariables<T>(values: Readonly<Record<string, string>>, run: () => T): T {
  const previous = Object.keys(values).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
