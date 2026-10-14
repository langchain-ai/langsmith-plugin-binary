export interface LocalRequest {
  method: string;
  path: string;
  apiKey: string | undefined;
  workspaceId: string | undefined;
  payload: Record<string, unknown>;
}
