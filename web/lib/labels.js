// Etiquetas de estado compartidas. Las clases CSS siguen usando el valor
// técnico (`state-applied`), pero la interfaz siempre habla en español.
const STATE_LABELS = {
  acknowledged: "Pago anunciado",
  applied: "Aplicada",
  applying: "Aplicando",
  blocked: "Bloqueada",
  cancelled: "Cancelada",
  cancel_pending: "Cancelación pendiente",
  commit_pending: "Confirmación pendiente",
  completed: "Completada",
  confirmed: "Confirmada",
  created: "Creada",
  draft: "Borrador",
  failed: "Fallida",
  open: "Abierta",
  paid: "Pagada",
  pending: "Pendiente",
  processing: "En proceso",
  received: "Recibida",
  reconciled: "Conciliada",
  released: "Liberada",
  reserved: "Reservada",
  reserving: "Reservando",
  settled: "Liquidada",
  uncertain: "Incierta",
};

const KIND_LABELS = {
  apply: "Aplicación",
  cancel: "Cancelación",
  edit: "Edición",
  paid: "Pago",
  received: "Recepción",
  rebalance: "Reajuste",
};

export function stateLabel(value) {
  if (value === undefined || value === null || value === "") return "—";
  return STATE_LABELS[value] ?? String(value).replaceAll("_", " ");
}

export function kindLabel(value) {
  if (value === undefined || value === null || value === "") return "—";
  return KIND_LABELS[value] ?? String(value).replaceAll("_", " ");
}
