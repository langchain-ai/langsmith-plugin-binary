export interface RotatedNotes {
  path: string;
  offset: number;
  rotatedAt: number;
}

export interface RotatedLeftover {
  path: string;
  base: number;
  nextBase: number;
}

export interface NotesRead {
  offset: number;
  size: number;
}
