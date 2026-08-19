import type { Thread } from "./Thread.js";

export type ThreadListParams = {
  limit: number;
  sortKey: string;
  sortDirection: string;
  archived: boolean;
  cwd: string;
  sourceKinds: string[];
};
