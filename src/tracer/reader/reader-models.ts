import type { ReadLine, TranscriptBuilder } from "../models.js";

export type LineIdReader = TranscriptBuilder["lineId"];

export type LineVisitor = (text: Buffer, end: number) => boolean;

export interface TranscriptRead {
  lines: ReadLine[];
  notices: string[];
  reachedEnd: boolean;
}
