import { UPLOAD_DEADLINE_MESSAGE, UPLOAD_SEND_DEADLINE_MS } from "./constants.js";
export async function withDeadline(work) {
    let timer;
    const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(UPLOAD_DEADLINE_MESSAGE)), UPLOAD_SEND_DEADLINE_MS);
    });
    try {
        return await Promise.race([work, expired]);
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=deadline.js.map