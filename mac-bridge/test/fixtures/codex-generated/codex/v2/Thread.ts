export type Thread = {
  id: string;
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  section: unknown;
  sectionEnteredAt: unknown;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number;
  status: { type: string; activeFlags?: string[] };
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: string;
  threadSource: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: unknown;
  name: string;
  turns: Array<{
    id: string;
    items: Array<{ type: string; text?: string; phase?: string }>;
    status: string;
  }>;
};
