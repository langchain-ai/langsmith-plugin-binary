export interface LocalRequest {
  method: string;
  path: string;
  payload: Record<string, unknown>;
}
