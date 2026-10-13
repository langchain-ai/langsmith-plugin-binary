const file = await import(process.argv[2]);
await file.publishExclusive(process.argv[3], process.argv[4], () => process.exit(71));
