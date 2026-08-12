import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import { ClientControlMessageSchema, ServerControlMessageSchema } from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageRoot, "schema/visor.v1.schema.json");
const clientControlMessage = zodToJsonSchema(ClientControlMessageSchema, {
  target: "jsonSchema7",
  $refStrategy: "none"
}) as Record<string, unknown>;
const serverControlMessage = zodToJsonSchema(ServerControlMessageSchema, {
  target: "jsonSchema7",
  $refStrategy: "none"
});
const hello = (clientControlMessage.anyOf as Array<Record<string, unknown>> | undefined)?.[0];
if (hello) {
  hello.oneOf = [
    { required: ["token"], not: { required: ["pairingCode"] } },
    { required: ["pairingCode"], not: { required: ["token"] } }
  ];
}
const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://codex-commander.local/schema/visor.v1.schema.json",
  title: "CodeX Commander visor.v1 protocol",
  definitions: {
    clientControlMessage,
    serverControlMessage
  }
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
