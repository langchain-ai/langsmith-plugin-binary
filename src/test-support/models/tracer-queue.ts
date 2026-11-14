export interface ReceivedBatch {
  posts: Record<string, unknown>[];
  patches: Record<string, unknown>[];
  body: string;
}

export interface FakeLangSmith {
  endpoint: string;
  batches: ReceivedBatch[];
  stored: Map<string, Record<string, unknown>>;
  inFlight: number;
  mostInFlight: number;
  failuresLeft: number;
  rejectMarker: string | undefined;
  holdResponses: boolean;
  release: () => void;
  close: () => Promise<void>;
}
