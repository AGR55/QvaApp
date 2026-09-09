export function operationActionBody(action, reference) {
  return action === "paid"
    ? { reference: String(reference ?? "").trim() }
    : {};
}
