export type ThreadForkParams = {
  threadId: string;
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: string;
  ephemeral: boolean;
  threadSource?: string;
};
