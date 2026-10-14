export interface LocalRequest {
  method: string;
  path: string;
  wire?: string;
  apiKey: string | undefined;
  workspaceId: string | undefined;
  payload: Record<string, unknown>;
}

export interface RunUnit {
  method: "POST" | "PATCH";
  path: string;
  payload: Record<string, unknown>;
  wire: string;
}
