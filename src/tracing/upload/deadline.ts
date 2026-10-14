import { UPLOAD_DEADLINE_MESSAGE, UPLOAD_SEND_DEADLINE_MS } from "./constants.js";

export async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(UPLOAD_DEADLINE_MESSAGE)), UPLOAD_SEND_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
