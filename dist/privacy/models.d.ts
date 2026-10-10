export type CodingAgentPrivacyContentRole = "assistant" | "user";
export type CodingAgentPrivacyStatus = "running" | "completed" | "error";
export interface CodingAgentRunExtra extends Record<string, unknown> {
    metadata?: Record<string, unknown>;
}
export interface CodingAgentPrivacyExtra extends CodingAgentRunExtra {
    toJSON(this: CodingAgentPrivacyExtra): {
        metadata: Record<string, unknown>;
    };
}
//# sourceMappingURL=models.d.ts.map