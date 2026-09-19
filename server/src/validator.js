import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaUrl = new URL("../../protocol/schemas/client-message.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(schema);

export const mutationTypes = new Set([
  "updateResource",
  "updateProduction",
  "updateTR",
  "runProduction",
  "resetPlayer",
]);

export function validateClientMessage(message) {
  return validate(message);
}

export function clientMessageValidationErrors() {
  return (validate.errors ?? []).map((issue) => {
    const location = issue.instancePath || "message";
    return `${location} ${issue.message}`.trim();
  });
}

export function formatClientMessageValidationError() {
  const details = clientMessageValidationErrors();
  return {
    code: "INVALID_MESSAGE",
    message: details.length > 0 ? details.join("; ").slice(0, 200) : "Message does not match the protocol schema",
  };
}
