const { launchDetachedWorker } = await import(process.argv[2]);
await launchDetachedWorker([], { executable: process.argv[3] });
