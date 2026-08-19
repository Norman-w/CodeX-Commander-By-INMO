export type TurnSteerParams = {
  threadId: string;
  expectedTurnId: string;
  input: Array<{ type: string; text: string; text_elements: unknown[] }>;
};
