import { UPLOAD_SAMPLING_RATE_VARIABLES } from "../tracing/upload/constants.js";

for (const name of UPLOAD_SAMPLING_RATE_VARIABLES) delete process.env[name];
