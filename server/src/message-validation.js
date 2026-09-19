import { formatClientMessageValidationError, validateClientMessage } from "./validator.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUUID = (value) => typeof value === "string" && UUID_PATTERN.test(value);

export function baseMessageError(message) {
  if (message?.protocolVersion && message.protocolVersion !== "v1") return { code: "UNSUPPORTED_PROTOCOL_VERSION", message: "protocolVersion must be v1" };
  return validateClientMessage(message) ? undefined : formatClientMessageValidationError();
}

export function messageShapeError(message) {
  return validateClientMessage(message) ? undefined : formatClientMessageValidationError();
}
