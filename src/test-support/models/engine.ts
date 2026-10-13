import type { ChildProcess } from "node:child_process";

export interface TestArea {
  root: string;
  children: Set<ChildProcess>;
}
