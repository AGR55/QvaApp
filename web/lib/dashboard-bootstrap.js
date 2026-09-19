export function readDashboardBootstrap(documentRef = document) {
  const node = documentRef.getElementById("qvaapply-bootstrap");
  if (!node) return undefined;
  const encoded = node.content?.textContent ?? node.textContent ?? "";
  node.remove();
  try {
    const value = JSON.parse(encoded);
    if (
      !value ||
      typeof value !== "object" ||
      !value.session ||
      typeof value.session !== "object" ||
      typeof value.session.authenticated !== "boolean"
    )
      return undefined;
    if (
      value.session.authenticated &&
      (typeof value.session.csrfToken !== "string" ||
        !value.dashboard ||
        typeof value.dashboard !== "object")
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
