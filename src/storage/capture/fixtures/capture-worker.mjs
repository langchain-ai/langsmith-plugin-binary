const input = JSON.parse(Buffer.from(process.argv[3], "base64").toString());
const store = await import(process.argv[2]);
console.log(JSON.stringify(await store.createCaptureStore(process.argv[4]).capture(input)));
