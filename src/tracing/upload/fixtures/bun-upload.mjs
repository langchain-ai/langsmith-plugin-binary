const api = await import(process.argv[2]);
const { destination, submission } = JSON.parse(process.argv[3]);
const writer = api.createLangSmithUploadWriter({ redact: false, destinations: [destination] });
await writer.send(submission, writer.destinations[0].id);
