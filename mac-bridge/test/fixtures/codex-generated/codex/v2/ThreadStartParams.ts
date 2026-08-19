import type { Thread } from "./Thread.js";

export type ThreadStartParams = {
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: string;
  serviceName?: string;
  threadSource?: string;
  model?: string;
  config?: {
    features?: { realtime_conversation?: boolean };
    realtime?: { version?: string; type?: string };
  };
};
