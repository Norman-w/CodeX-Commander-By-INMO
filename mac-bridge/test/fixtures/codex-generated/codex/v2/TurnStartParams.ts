import type { SandboxPolicy } from "./SandboxPolicy.js";

export type TurnStartParams = {
  threadId: string;
  input: Array<{ type: string; text: string; text_elements: unknown[] }>;
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandboxPolicy: SandboxPolicy;
  model?: string;
};
