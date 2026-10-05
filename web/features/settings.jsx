import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  Copy,
  History,
  ImagePlus,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
  Webhook,
  X,
} from "lucide-react";
import { Empty, Panel, Skeleton, ViewHead } from "../components/common.jsx";
import { requestJson } from "../lib/http.js";
import { Button, Field, Input, Textarea } from "../components/ui.jsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import {
  FieldContent,
  Field as ShadcnField,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.tsx";

const riskFields = [
  ["maxQusdPerOperation", "Máximo por operación", "QUSD"],
  ["maxConcurrentQusdExposure", "Exposición simultánea", "QUSD"],
  ["maxDailyAppliedQusd", "Volumen diario", "QUSD"],
  ["maxConcurrentOperations", "Operaciones simultáneas", "operaciones"],
  ["minQusdReserve", "Reserva mínima", "QUSD"],
  ["maxQuoteAgeSeconds", "Antigüedad máxima", "segundos"],
  ["minExpectedMarginPercent", "Margen mínimo", "%"],
  ["maxSlippagePercent", "Deslizamiento máximo", "%"],
  ["maxConsecutiveErrors", "Errores antes de pausar", "errores"],
  ["marketCooldownSeconds", "Enfriamiento por mercado", "segundos"],
  ["counterpartyCooldownSeconds", "Enfriamiento por contraparte", "segundos"],
];
const automationFields = [
  ["scanIntervalSeconds", "Intervalo de escaneo", "segundos", 3],
  ["autoCancelMinutes", "Cancelación automática", "minutos", 1],
  ["offerRefreshIntervalMinutes", "Refresco de ofertas propias", "minutos", 1],
  ["offerRefreshSpacingSeconds", "Separación entre refrescos", "segundos", 20],
  ["priceGuardPercent", "Cortafuegos frente a la mediana", "%", 1],
];

export function Settings({ initialConfig, initialRevisions, onChanged }) {
  const [saved, setSaved] = useState(() => initialConfig);
  const [draft, setDraft] = useState(() =>
    initialConfig ? structuredClone(initialConfig) : undefined,
  );
  const [revisions, setRevisions] = useState(() => initialRevisions || []);
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState(
    "Revisión de límites y mercados desde la mesa de operaciones",
  );
  const [status, setStatus] = useState("Cargando configuración…");
  const closeReview = useCallback(() => setReviewing(false), []);

  const load = async () => {
    try {
      const configPayload = await requestJson("/api/config");
      setSaved(configPayload.data);
      setDraft(structuredClone(configPayload.data));
      setStatus("");
      try {
        const revisionPayload = await requestJson("/api/config-revisions");
        setRevisions(revisionPayload.data || []);
      } catch {
        setStatus(
          "Configuración disponible; el historial se reintentará después.",
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo cargar.");
    }
  };
  useEffect(() => {
    if (!initialConfig) void load();
  }, []);

  const changes = useMemo(() => diffConfig(saved, draft), [saved, draft]);
  const requiresInitialReview = draft?.risk.reviewedAt === null;
  if (!draft)
    return (
      <Panel title="Estrategia y riesgo" wide>
        <Skeleton rows={7} label={status || "Leyendo configuración"} />
      </Panel>
    );

  const updateRisk = (key, value) =>
    setDraft((current) => ({
      ...current,
      risk: { ...current.risk, [key]: Number(value) },
    }));
  const updateMarket = (index, key, value) =>
    setDraft((current) => ({
      ...current,
      markets: current.markets.map((market, position) =>
        position === index
          ? {
              ...market,
              [key]: ["active", "label", "currency", "code", "iconUrl", "color"].includes(key)
                ? value
                : Number(value),
            }
          : market,
      ),
    }));
  const updateDetail = (marketIndex, detailIndex, key, value) =>
    setDraft((current) => ({
      ...current,
      markets: current.markets.map((market, index) =>
        index !== marketIndex
          ? market
          : {
              ...market,
              paymentDetails: market.paymentDetails.map((detail, position) =>
                position === detailIndex ? { ...detail, [key]: value } : detail,
              ),
            },
      ),
    }));
  const addDetail = (marketIndex) =>
    setDraft((current) => ({
      ...current,
      markets: current.markets.map((market, index) =>
        index === marketIndex
          ? {
              ...market,
              paymentDetails: [
                ...market.paymentDetails,
                { name: "", value: "" },
              ],
            }
          : market,
      ),
    }));
  const removeDetail = (marketIndex, detailIndex) =>
    setDraft((current) => ({
      ...current,
      markets: current.markets.map((market, index) =>
        index === marketIndex
          ? {
              ...market,
              paymentDetails: market.paymentDetails.filter(
                (_, position) => position !== detailIndex,
              ),
            }
          : market,
      ),
    }));
  const addMarket = () =>
    setDraft((current) => {
      const codes = new Set(current.markets.map((market) => market.code));
      let suffix = 1;
      while (codes.has(suffix === 1 ? "NUEVO" : `NUEVO_${suffix}`)) suffix += 1;
      return {
        ...current,
        markets: [
          ...current.markets,
          {
          code: suffix === 1 ? "NUEVO" : `NUEVO_${suffix}`,
          label: "Nuevo mercado",
          currency: "",
          color: "#6f8494",
          active: false,
          huntBuyEnabled: false,
          huntSellEnabled: false,
          fiatBalance: 0,
          buyMaxRate: 1,
          sellMinRate: 1,
          priceGuardPercent: undefined,
          purchaseMaxQusd: 0,
          sellFeePercent: 0,
          outgoingTransferFee: 0,
          paymentDetails: [],
        },
      ],
      };
    });
  const removeMarket = (index) =>
    setDraft((current) => ({
      ...current,
      markets: current.markets.filter((_, position) => position !== index),
    }));
  const save = async () => {
    setStatus("Guardando revisión…");
    try {
      await requestJson("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: draft,
          reason,
        }),
      });
      setReviewing(false);
      await load();
      await onChanged?.();
      setStatus("Configuración activa y auditada.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo guardar.");
    }
  };

  return (
    <div className="settings-stack">
      <ViewHead
        title="Estrategia"
      />
      <Panel title="Límites de riesgo" wide>
        <form onSubmit={(event) => event.preventDefault()}>
          <FieldGroup className="settings-form">
          <SettingField label="Máximo de ofertas propias" htmlFor="max-open-offers">
            <span className="input-unit">
              <Input
                id="max-open-offers"
                type="number"
                min="1"
                step="1"
                value={draft.maxOpenOffers}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    maxOpenOffers: Number(event.target.value),
                  }))
                }
              />
              <small>ofertas</small>
            </span>
          </SettingField>
          {riskFields.map(([key, label, unit]) => (
            <SettingField key={key} label={label} htmlFor={`risk-${key}`}>
              <span className="input-unit">
                <Input
                  id={`risk-${key}`}
                  type="number"
                  min="0"
                  step={
                    key.includes("Operations") || key.includes("Errors")
                      ? "1"
                      : "0.01"
                  }
                  value={draft.risk[key]}
                  onChange={(event) => updateRisk(key, event.target.value)}
                />
                <small>{unit}</small>
              </span>
            </SettingField>
          ))}
          <div className="form-actions" aria-live="polite">
            <Button
              type="button"
              variant="primary"
              disabled={!changes.length && !requiresInitialReview}
              onClick={() => setReviewing(true)}
            >
              <Save aria-hidden="true" data-icon="inline-start" />{" "}
              {requiresInitialReview && !changes.length
                ? "Revisar y aprobar límites"
                : `Revisar ${changes.length} cambio(s)`}
            </Button>
            <span>{status}</span>
          </div>
          </FieldGroup>
        </form>
      </Panel>

      <Panel title="Comportamiento del bot" wide>
        <form onSubmit={(event) => event.preventDefault()}>
          <FieldGroup className="settings-form">
          {automationFields.map(([key, label, unit, minimum]) => (
            <SettingField key={key} label={label} htmlFor={`automation-${key}`}>
              <span className="input-unit">
                <Input
                  id={`automation-${key}`}
                  type="number"
                  min={minimum}
                  step="1"
                  value={draft.automation[key]}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      automation: {
                        ...current.automation,
                        [key]: Number(event.target.value),
                      },
                    }))
                  }
                />
                <small>{unit}</small>
              </span>
            </SettingField>
          ))}
          <SettingField
            className="message-setting"
            label="Mensaje automático en el chat P2P"
            htmlFor="automation-welcome-message"
          >
            <Textarea
              id="automation-welcome-message"
              maxLength="79"
              rows="3"
              value={draft.automation.welcomeMessage}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  automation: {
                    ...current.automation,
                    welcomeMessage: event.target.value,
                  },
                }))
              }
            />
            <small>{draft.automation.welcomeMessage.length}/79</small>
          </SettingField>
          </FieldGroup>
        </form>
      </Panel>

      <MarketSourceSettings />

      <Panel title="Mercados y precios" wide>
        <div className="market-settings-grid">
          {draft.markets.map((market, index) => (
            <section key={market.code} className="market-settings" aria-labelledby={`market-settings-${index}`}>
              <header className="market-settings-head">
                <h3 id={`market-settings-${index}`}>{market.label}</h3>
                <ShadcnField orientation="horizontal" className="toggle-field">
                  <Checkbox
                    id={`market-active-${index}`}
                    checked={market.active}
                    aria-label={`Activar ${market.label}`}
                    onCheckedChange={(checked) => updateMarket(index, "active", checked === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`market-active-${index}`}>Activo</FieldLabel>
                  </FieldContent>
                </ShadcnField>
              </header>
              <FieldGroup className="market-settings-content">
              <MarketField label="Código QvaPay" htmlFor={`market-code-${index}`}>
                <Input
                  id={`market-code-${index}`}
                  value={market.code}
                  onChange={(event) =>
                    updateMarket(
                      index,
                      "code",
                      event.target.value.toUpperCase(),
                    )
                  }
                />
              </MarketField>
              <MarketField label="Nombre visible" htmlFor={`market-label-${index}`}>
                <Input
                  id={`market-label-${index}`}
                  value={market.label}
                  onChange={(event) =>
                    updateMarket(index, "label", event.target.value)
                  }
                />
              </MarketField>
              <MarketIconEditor
                market={market}
                onChange={(iconUrl) => updateMarket(index, "iconUrl", iconUrl)}
              />
              <MarketField label="Color identificativo">
                <span className="market-color-field">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="color-picker-trigger"
                        aria-label={`Cambiar color de ${market.label}`}
                      >
                        <span
                          aria-hidden="true"
                          className="color-swatch"
                          style={{ backgroundColor: market.color || "#6f8494" }}
                        />
                        Elegir
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="color-picker-popover">
                      <Field label="Color identificativo" htmlFor={`market-color-${index}`}>
                        <Input
                          id={`market-color-${index}`}
                          className="color-input"
                          type="color"
                          value={market.color || "#6f8494"}
                          onChange={(event) =>
                            updateMarket(index, "color", event.target.value)
                          }
                        />
                      </Field>
                    </PopoverContent>
                  </Popover>
                  <code>{market.color || "#6f8494"}</code>
                </span>
              </MarketField>
              <MarketField label="Moneda fiat" htmlFor={`market-currency-${index}`}>
                <Input
                  id={`market-currency-${index}`}
                  value={market.currency}
                  onChange={(event) =>
                    updateMarket(
                      index,
                      "currency",
                      event.target.value.toUpperCase(),
                    )
                  }
                />
              </MarketField>
              <MarketField label="Saldo fiat declarado" htmlFor={`market-balance-${index}`}>
                <Input
                  id={`market-balance-${index}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={market.fiatBalance}
                  onChange={(event) =>
                    updateMarket(index, "fiatBalance", event.target.value)
                  }
                />
              </MarketField>
              <MarketField label="Máximo de compra" htmlFor={`market-buy-rate-${index}`}>
                <Input
                  id={`market-buy-rate-${index}`}
                  type="number"
                  min="0.0000001"
                  step="0.0001"
                  value={market.buyMaxRate}
                  onChange={(event) =>
                    updateMarket(index, "buyMaxRate", event.target.value)
                  }
                />
              </MarketField>
              <MarketField label="Mínimo de venta" htmlFor={`market-sell-rate-${index}`}>
                <Input
                  id={`market-sell-rate-${index}`}
                  type="number"
                  min="0.0000001"
                  step="0.0001"
                  value={market.sellMinRate}
                  onChange={(event) =>
                    updateMarket(index, "sellMinRate", event.target.value)
                  }
                />
              </MarketField>
              <MarketField label="Cortafuegos del mercado (%)" htmlFor={`market-guard-${index}`}>
                <Input
                  id={`market-guard-${index}`}
                  type="number"
                  min="1"
                  max="100"
                  step="0.1"
                  value={
                    market.priceGuardPercent ??
                    draft.automation.priceGuardPercent
                  }
                  onChange={(event) =>
                    updateMarket(
                      index,
                      "priceGuardPercent",
                      event.target.value,
                    )
                  }
                />
              </MarketField>
              <MarketField label="Máximo QUSD por compra" htmlFor={`market-max-amount-${index}`}>
                <Input
                  id={`market-max-amount-${index}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={market.purchaseMaxQusd}
                  onChange={(event) =>
                    updateMarket(index, "purchaseMaxQusd", event.target.value)
                  }
                />
              </MarketField>
              <MarketField label="Comisión de venta (%)" htmlFor={`market-fee-${index}`}>
                <Input
                  id={`market-fee-${index}`}
                  type="number"
                  min="0"
                  max="99.99"
                  step="0.01"
                  value={market.sellFeePercent}
                  onChange={(event) =>
                    updateMarket(index, "sellFeePercent", event.target.value)
                  }
                />
              </MarketField>
              <MarketField label="Comisión fija de salida" htmlFor={`market-outgoing-fee-${index}`}>
                <span className="input-unit">
                  <Input
                    id={`market-outgoing-fee-${index}`}
                    type="number"
                    min="0"
                    step="0.01"
                    value={market.outgoingTransferFee}
                    onChange={(event) =>
                      updateMarket(
                        index,
                        "outgoingTransferFee",
                        event.target.value,
                      )
                    }
                  />
                  <small>{market.currency}</small>
                </span>
              </MarketField>
              <FieldSet className="payment-details">
                <FieldLegend>Datos de cobro</FieldLegend>
                {market.paymentDetails.map((detail, detailIndex) => (
                  <div key={detailIndex}>
                    <ShadcnField className="contents">
                      <FieldLabel className="sr-only" htmlFor={`payment-detail-name-${index}-${detailIndex}`}>Nombre del dato {detailIndex + 1}</FieldLabel>
                      <Input
                        id={`payment-detail-name-${index}-${detailIndex}`}
                        placeholder="Campo"
                        value={detail.name}
                        onChange={(event) =>
                          updateDetail(
                            index,
                            detailIndex,
                            "name",
                            event.target.value,
                          )
                        }
                      />
                    </ShadcnField>
                    <ShadcnField className="contents">
                      <FieldLabel className="sr-only" htmlFor={`payment-detail-value-${index}-${detailIndex}`}>Valor del dato {detailIndex + 1}</FieldLabel>
                      <Input
                        id={`payment-detail-value-${index}-${detailIndex}`}
                        placeholder="Valor"
                        value={detail.value}
                        onChange={(event) =>
                          updateDetail(
                            index,
                            detailIndex,
                            "value",
                            event.target.value,
                          )
                        }
                      />
                    </ShadcnField>
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label="Eliminar dato"
                      onClick={() => removeDetail(index, detailIndex)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => addDetail(index)}
                >
                  <Plus aria-hidden="true" data-icon="inline-start" /> Añadir dato
                </Button>
              </FieldSet>
              </FieldGroup>
              <footer className="market-settings-footer">
                <Button
                  variant="destructive"
                  size="sm"
                  type="button"
                  onClick={() => removeMarket(index)}
                >
                  <Trash2 aria-hidden="true" /> Eliminar mercado
                </Button>
              </footer>
            </section>
          ))}
        </div>
        <Button
          variant="primary"
          type="button"
          className="add-market"
          onClick={addMarket}
        >
          <Plus aria-hidden="true" data-icon="inline-start" /> Añadir mercado
        </Button>
      </Panel>

      <Dialog open={reviewing} onOpenChange={setReviewing}>
        <DialogContent className="review-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Revisa el impacto antes de activar</DialogTitle>
            <DialogDescription>
              Los cambios se aplicarán a la configuración activa.
            </DialogDescription>
          </DialogHeader>
            <ul className="change-list">
              {requiresInitialReview && !changes.length ? (
                <li>
                  <span>Política de riesgo inicial</span>
                  <del>Sin revisar</del>
                  <strong>Aprobada</strong>
                </li>
              ) : null}
              {changes.map((change) => (
                <li key={change.key}>
                  <span>{change.label}</span>
                  <del>{change.before}</del>
                  <strong>{change.after}</strong>
                </li>
              ))}
            </ul>
            <Field label="Motivo de la revisión" htmlFor="review-reason" className="reason-field">
              <Input
                id="review-reason"
                value={reason}
                minLength="5"
                required
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={closeReview}>
                Volver
              </Button>
              <Button
                variant="primary"
                type="button"
                disabled={reason.trim().length < 5}
                onClick={save}
              >
                <Check aria-hidden="true" data-icon="inline-start" /> Confirmar y activar
              </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      <Panel title="Historial de revisiones" wide>
        {revisions.length ? (
          <ol className="revision-list">
            {revisions.slice(0, 10).map((revision) => (
              <li key={revision.id}>
                <History aria-hidden="true" />
                <span>
                  <strong>{revision.source}</strong>
                  <small>
                    {new Date(revision.createdAt).toLocaleString("es-CU")}
                  </small>
                </span>
                <code>{revision.hash.slice(0, 12)}</code>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>Sin revisiones registradas.</Empty>
        )}
      </Panel>
    </div>
  );
}

function streamPhaseLabel(phase) {
  return ({
    idle: "Detenido",
    connecting: "Conectando…",
    connected: "Conectado",
    backoff: "Reconectando…",
    unauthorized: "Credenciales rechazadas",
    subscription_required: "Suscripción requerida",
    expired: "Suscripción vencida",
  })[phase] || "Sin iniciar";
}

function MarketSourceSettings() {
  const [source, setSource] = useState();
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState();
  const [removing, setRemoving] = useState();
  const [form, setForm] = useState({ label: "", token: "", intervalSeconds: 3 });
  const [feedSecret, setFeedSecret] = useState("");
  const [streamCredentials, setStreamCredentials] = useState({ appId: "", appSecret: "" });
  const load = useCallback(async () => {
    try {
      const payload = await requestJson("/api/market-source");
      setSource(payload.data);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo leer la fuente de mercado.");
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openAdd = () => {
    setForm({ label: "", token: "", intervalSeconds: 3 });
    setEditor({ mode: "add" });
  };
  const openRotate = (account) => {
    setForm({ label: account.label, token: "", intervalSeconds: account.intervalSeconds });
    setEditor({ mode: "rotate", account });
  };
  const submitToken = async () => {
    setMessage(editor?.mode === "add" ? "Validando cuenta lectora…" : "Validando token nuevo…");
    try {
      if (editor?.mode === "add")
        await requestJson("/api/market-readers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(form),
          timeoutMs: 20_000,
        });
      else if (editor?.account)
        await requestJson(`/api/market-readers/${encodeURIComponent(editor.account.id)}/token`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: form.token }),
          timeoutMs: 20_000,
        });
      setEditor(undefined);
      setForm({ label: "", token: "", intervalSeconds: 3 });
      await load();
      setMessage("Cuenta lectora validada y activa.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo validar la cuenta.");
    }
  };
  const update = async (account, changes) => {
    setMessage(`Actualizando ${account.label}…`);
    try {
      await requestJson(`/api/market-readers/${encodeURIComponent(account.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      await load();
      setMessage("Cuenta lectora actualizada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar.");
    }
  };
  const remove = async () => {
    if (!removing) return;
    setMessage(`Eliminando ${removing.label}…`);
    try {
      await requestJson(`/api/market-readers/${encodeURIComponent(removing.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      setRemoving(undefined);
      await load();
      setMessage("Cuenta lectora eliminada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo eliminar.");
    }
  };
  const changeMode = async (mode) => {
    setMessage(`Activando ${mode === "hybrid" ? "tiempo real" : "polling"}…`);
    try {
      const payload = await requestJson("/api/market-source", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      setSource((current) => ({ ...current, ...payload.data }));
      setMessage(mode === "hybrid" ? "Tiempo real activo: stream rápido con webhook de respaldo." : "Polling activo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo cambiar la fuente.");
    }
  };
  const saveFeedSecret = async () => {
    setMessage("Guardando secreto cifrado…");
    try {
      const payload = await requestJson("/api/market-source/webhook-secret", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: feedSecret }),
      });
      setFeedSecret("");
      setSource((current) => ({ ...current, ...payload.data }));
      setMessage("Secreto del webhook guardado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar el secreto.");
    }
  };
  const saveStreamCredentials = async () => {
    setMessage("Guardando credenciales cifradas del stream…");
    try {
      const payload = await requestJson("/api/market-source/stream-credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(streamCredentials),
      });
      setStreamCredentials({ appId: "", appSecret: "" });
      setSource((current) => ({ ...current, ...payload.data }));
      setMessage("Credenciales del stream guardadas. No se mostrarán de nuevo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron guardar las credenciales.");
    }
  };
  const copyWebhookUrl = async () => {
    if (!source?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(source.webhookUrl);
      setMessage("URL del webhook copiada.");
    } catch {
      setMessage("No se pudo copiar automáticamente; selecciona la URL.");
    }
  };

  const primary = source?.accounts?.find((account) => account.role === "primary");
  const healthById = new Map((source?.accounts || []).map((account) => [account.id, account]));
  const readers = (source?.readers || []).map((account) => ({
    ...account,
    ...(healthById.get(account.id) || {}),
  }));
  return (
    <Panel title="Fuente de mercado" wide>
      <div className="market-source-mode" aria-label="Modo de fuente de mercado">
        <div>
          <strong>Modo activo</strong>
          <p>Tiempo real usa stream SSE y conserva el webhook como red de seguridad.</p>
        </div>
        <div className="market-source-mode-buttons">
          <Button type="button" variant={source?.mode === "polling" ? "primary" : "outline"} onClick={() => void changeMode("polling")}>
            <RefreshCw aria-hidden="true" data-icon="inline-start" /> Polling
          </Button>
          <Button type="button" variant={source?.mode === "hybrid" ? "primary" : "outline"} disabled={!source?.webhookSecretConfigured || !source?.streamCredentialsConfigured} onClick={() => void changeMode("hybrid")}>
            <Webhook aria-hidden="true" data-icon="inline-start" /> Tiempo real
          </Button>
        </div>
      </div>
      <div className="market-webhook-setup">
        <div className="market-webhook-url">
          <span>
            <small>URL para QvaPay · selecciona los 6 eventos P2P</small>
            <code>{source?.webhookUrl || "Cargando…"}</code>
          </span>
          <Button type="button" variant="ghost" size="icon" aria-label="Copiar URL del webhook" onClick={() => void copyWebhookUrl()}>
            <Copy aria-hidden="true" />
          </Button>
        </div>
        <Field label={source?.webhookSecretConfigured ? "Rotar secreto del feed" : "Secreto del feed"} htmlFor="market-feed-secret">
          <span className="market-webhook-secret">
            <Input id="market-feed-secret" type="password" autoComplete="off" minLength="16" maxLength="512" placeholder={source?.webhookSecretConfigured ? "Configurado · pega otro para rotarlo" : "Pega el secreto mostrado por QvaPay"} value={feedSecret} onChange={(event) => setFeedSecret(event.target.value)} />
            <Button type="button" variant="secondary" disabled={feedSecret.trim().length < 16} onClick={() => void saveFeedSecret()}>
              <KeyRound aria-hidden="true" data-icon="inline-start" /> Guardar
            </Button>
          </span>
        </Field>
        <div className="market-stream-credentials">
          <Field label={source?.streamCredentialsConfigured ? "Rotar app-id" : "App ID de QvaPay"} htmlFor="market-stream-app-id">
            <Input id="market-stream-app-id" type="password" autoComplete="off" minLength="4" maxLength="256" placeholder={source?.streamCredentialsConfigured ? "Configurado · pega otro para rotarlo" : "App ID de qvapay.com/dev"} value={streamCredentials.appId} onChange={(event) => setStreamCredentials((current) => ({ ...current, appId: event.target.value }))} />
          </Field>
          <Field label={source?.streamCredentialsConfigured ? "Rotar app-secret" : "App Secret de QvaPay"} htmlFor="market-stream-app-secret">
            <span className="market-webhook-secret">
              <Input id="market-stream-app-secret" type="password" autoComplete="off" minLength="16" maxLength="512" placeholder={source?.streamCredentialsConfigured ? "Configurado · pega otro para rotarlo" : "App Secret de qvapay.com/dev"} value={streamCredentials.appSecret} onChange={(event) => setStreamCredentials((current) => ({ ...current, appSecret: event.target.value }))} />
              <Button type="button" variant="secondary" disabled={streamCredentials.appId.trim().length < 4 || streamCredentials.appSecret.trim().length < 16} onClick={() => void saveStreamCredentials()}>
                <KeyRound aria-hidden="true" data-icon="inline-start" /> Guardar
              </Button>
            </span>
          </Field>
        </div>
      </div>
      <div className="market-source-summary">
        <div>
          {source?.mode === "hybrid" ? <Webhook aria-hidden="true" /> : <Activity aria-hidden="true" />}
          <span>
            <small>{source?.mode === "hybrid" ? "Stream" : "Cadencia estimada"}</small>
            <strong>
              {source?.mode === "hybrid"
                ? streamPhaseLabel(source?.streamPhase)
                : source?.effectiveCadenceSeconds
                ? `1 consulta cada ${source.effectiveCadenceSeconds.toFixed(2)} s`
                : "Sin cuentas disponibles"}
            </strong>
          </span>
        </div>
        <div>
          <Wifi aria-hidden="true" />
          <span>
            <small>{source?.mode === "hybrid" ? "Último evento" : "Cuentas saludables"}</small>
            <strong>{source?.mode === "hybrid" ? formatReaderTime(Math.max(source?.lastStreamReceivedAt || 0, source?.lastWebhookReceivedAt || 0)) : source?.healthyAccounts ?? "—"}</strong>
          </span>
        </div>
        <div>
          <ShieldCheck aria-hidden="true" />
          <span>
            <small>{source?.mode === "hybrid" ? "Cola del feed" : "Consumo previsto"}</small>
            <strong>{source?.mode === "hybrid" ? `${source?.pendingWebhookEvents || 0} pendientes · ${source?.failedWebhookEvents || 0} fallidos` : source ? `${Math.round(source.estimatedRequestsPerMinute)} consultas/min` : "—"}</strong>
          </span>
        </div>
      </div>
      {source?.mode === "hybrid" && source?.lastEventOutcome ? (
        <p className="reader-health-detail" role="status">
          Último resultado: {source.lastEventOutcome}
          {Number.isFinite(source?.lastDeliveryLagMs) ? ` · entrega ${source.lastDeliveryLagMs} ms` : ""}
          {Number.isFinite(source?.lastEventLatencyMs) ? ` · proceso ${source.lastEventLatencyMs} ms` : ""}
        </p>
      ) : null}
      {source?.lastWebhookError ? <p className="reader-error" role="status">Webhook: {source.lastWebhookError}</p> : null}
      {source?.lastStreamError ? <p className="reader-error" role="status">Stream: {source.lastStreamError}</p> : null}
      <div className="market-reader-list">
        <MarketReaderCard account={{
          id: "primary",
          label: "Cuenta principal",
          role: "primary",
          enabled: true,
          intervalSeconds: primary?.intervalSeconds || 3,
          health: primary?.health || "healthy",
          lastSuccessAt: primary?.lastSuccessAt ?? null,
          lastError: primary?.lastError,
        }} />
        {readers.map((account) => (
          <MarketReaderCard
            key={account.id}
            account={account}
            onToggle={() => void update(account, { enabled: !account.enabled })}
            onInterval={(intervalSeconds) => void update(account, { intervalSeconds })}
            onRotate={() => openRotate(account)}
            onRemove={() => setRemoving(account)}
          />
        ))}
      </div>
      <div className="market-source-actions">
        <Button type="button" variant="primary" onClick={openAdd}>
          <Plus aria-hidden="true" data-icon="inline-start" /> Añadir cuenta lectora
        </Button>
        <p aria-live="polite">{message}</p>
      </div>

      <Dialog open={Boolean(editor)} onOpenChange={(open) => !open && setEditor(undefined)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{editor?.mode === "add" ? "Añadir cuenta lectora" : "Rotar token de lectura"}</DialogTitle>
            <DialogDescription>
              Usa un token de QvaPay limitado a p2p:read. Se validará y cifrará antes de guardarlo.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {editor?.mode === "add" ? (
              <Field label="Etiqueta" htmlFor="reader-label">
                <Input
                  id="reader-label"
                  maxLength="60"
                  value={form.label}
                  onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                />
              </Field>
            ) : null}
            <Field label="Token p2p:read" htmlFor="reader-token">
              <Input
                id="reader-token"
                type="password"
                autoComplete="off"
                value={form.token}
                onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))}
              />
            </Field>
            {editor?.mode === "add" ? (
              <Field label="Intervalo mínimo" htmlFor="reader-interval">
                <span className="input-unit">
                  <Input
                    id="reader-interval"
                    type="number"
                    min="3"
                    max="3600"
                    step="1"
                    value={form.intervalSeconds}
                    onChange={(event) => setForm((current) => ({ ...current, intervalSeconds: Number(event.target.value) }))}
                  />
                  <small>segundos</small>
                </span>
              </Field>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setEditor(undefined)}>Cancelar</Button>
            <Button
              type="button"
              variant="primary"
              disabled={form.token.trim().length < 12 || (editor?.mode === "add" && !form.label.trim())}
              onClick={() => void submitToken()}
            >
              <KeyRound aria-hidden="true" data-icon="inline-start" /> Validar y guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Eliminar cuenta lectora</DialogTitle>
            <DialogDescription>
              Se borrará el token cifrado de {removing?.label}. La cuenta principal no se modifica.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRemoving(undefined)}>Cancelar</Button>
            <Button type="button" variant="destructive" onClick={() => void remove()}>
              <Trash2 aria-hidden="true" data-icon="inline-start" /> Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function MarketReaderCard({ account, onToggle, onInterval, onRotate, onRemove }) {
  const healthy = account.health === "healthy";
  return (
    <article className={`market-reader-card ${healthy ? "healthy" : account.health}`}>
      <header>
        <span className="market-reader-icon" aria-hidden="true">
          {healthy ? <Wifi /> : <WifiOff />}
        </span>
        <div>
          <h3>{account.label}</h3>
          <p>{account.role === "primary" ? "Opera y observa" : "Solo observa · p2p:read"}</p>
        </div>
        <span className="reader-health">{healthLabel(account.health)}</span>
      </header>
      <dl>
        <div><dt>Última lectura</dt><dd>{formatReaderTime(account.lastSuccessAt)}</dd></div>
        <div><dt>Intervalo</dt><dd>{account.intervalSeconds} s</dd></div>
      </dl>
      {account.lastError ? <p className="reader-error" role="status">{account.lastError}</p> : null}
      {account.role === "reader" ? (
        <footer>
          <Field label="Intervalo" htmlFor={`reader-interval-${account.id}`}>
            <Input
              id={`reader-interval-${account.id}`}
              type="number"
              min="3"
              max="3600"
              step="1"
              defaultValue={account.intervalSeconds}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (value !== account.intervalSeconds) onInterval?.(value);
              }}
            />
          </Field>
          <Button type="button" size="sm" variant="outline" onClick={onToggle}>
            {account.enabled ? "Desactivar" : "Activar"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRotate}>
            <RefreshCw aria-hidden="true" data-icon="inline-start" /> Rotar token
          </Button>
          <Button type="button" size="icon" variant="ghost" aria-label={`Eliminar ${account.label}`} onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </Button>
        </footer>
      ) : null}
    </article>
  );
}

function healthLabel(health) {
  return {
    healthy: "Saludable",
    cooldown: "En espera",
    requires_attention: "Requiere atención",
    error: "Reintentando",
  }[health] || "Sin datos";
}

function formatReaderTime(value) {
  return value ? new Date(value).toLocaleTimeString("es-CU") : "Todavía no";
}

function SettingField({ label, htmlFor, children, className }) {
  return (
    <Field label={label} htmlFor={htmlFor} className={`settings-field ${className || ""}`}>
      {children}
    </Field>
  );
}

function MarketField({ label, htmlFor, children }) {
  return (
    <Field label={label} htmlFor={htmlFor} className="market-setting-field">
      {children}
    </Field>
  );
}

function MarketIconEditor({ market, onChange }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const choose = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const prepared = await optimizeMarketIcon(file);
      const base64 = await fileBase64(prepared);
      const payload = await requestJson("/api/market-icons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: prepared === file ? file.name : `${file.name.replace(/\.[^.]+$/, "")}.webp`,
          mimeType: prepared.type || imageMimeFromName(file.name),
          base64,
        }),
        timeoutMs: 20_000,
      });
      onChange(payload.data.url);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "No se pudo subir el icono.",
      );
    } finally {
      setUploading(false);
    }
  };
  const initial = String(market.label || market.code || "?")
    .trim()
    .slice(0, 1)
    .toUpperCase();
  return (
    <div className="market-icon-editor">
      <strong>Icono del mercado</strong>
      <div>
        {market.iconUrl ? (
          <img src={market.iconUrl} alt="" width="44" height="44" />
        ) : (
          <span aria-hidden="true">{initial}</span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus aria-hidden="true" data-icon="inline-start" />
          {uploading ? "Subiendo…" : "Elegir icono"}
        </Button>
        {market.iconUrl ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={uploading}
            aria-label="Quitar icono"
            onClick={() => onChange("")}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
        <Input
          ref={inputRef}
          id={`market-icon-file-${market.code}`}
          className="sr-only"
          type="file"
          aria-label={`Seleccionar icono para ${market.label}`}
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={(event) => void choose(event)}
        />
      </div>
      <small>PNG, WebP, JPEG o SVG seguro · los raster se reducen a 64×64 y menos de 10 KB</small>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("No se pudo leer el archivo seleccionado."));
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function optimizeMarketIcon(file) {
  if ((file.type || imageMimeFromName(file.name)) === "image/svg+xml") {
    if (file.size > 10_000) throw new Error("El SVG debe pesar menos de 10 KB.");
    return file;
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Este navegador no puede preparar iconos.");
    const scale = Math.min(64 / bitmap.width, 64 / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (64 - width) / 2, (64 - height) / 2, width, height);
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      const icon = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (icon?.type === "image/webp" && icon.size <= 10_000) return icon;
    }
    throw new Error("No se pudo reducir el icono a menos de 10 KB.");
  } finally {
    bitmap.close();
  }
}

function imageMimeFromName(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
  }[extension] || "";
}

function diffConfig(saved, draft) {
  if (!saved || !draft) return [];
  const rootChanges = [["maxOpenOffers", "Máximo de ofertas propias"]].flatMap(
    ([key, label]) =>
      saved[key] === draft[key]
        ? []
        : [{ key, label, before: saved[key], after: draft[key] }],
  );
  const riskChanges = riskFields.flatMap(([key, label]) =>
    saved.risk[key] === draft.risk[key]
      ? []
      : [{ key, label, before: saved.risk[key], after: draft.risk[key] }],
  );
  const automationChanges = [
    ...automationFields.map(([key, label]) => [key, label]),
    ["welcomeMessage", "Mensaje automático P2P"],
  ].flatMap(([key, label]) =>
    saved.automation?.[key] === draft.automation?.[key]
      ? []
      : [
          {
            key: `automation:${key}`,
            label,
            before: saved.automation?.[key] ?? "",
            after: draft.automation?.[key] ?? "",
          },
        ],
  );
  const marketChanges = draft.markets.flatMap((market, index) => {
    const before = saved.markets[index];
    if (!before)
      return [
        {
          key: `market:${market.code}`,
          label: market.label,
          before: "Nuevo",
          after: "Activo",
        },
      ];
    return [
      "code",
      "label",
      "currency",
      "iconUrl",
      "color",
      "active",
      "huntBuyEnabled",
      "huntSellEnabled",
      "fiatBalance",
      "buyMaxRate",
      "sellMinRate",
      "priceGuardPercent",
      "purchaseMaxQusd",
      "sellFeePercent",
      "outgoingTransferFee",
      "paymentDetails",
    ].flatMap((key) =>
      JSON.stringify(before[key]) === JSON.stringify(market[key])
        ? []
        : [
            {
              key: `market:${market.code}:${key}`,
              label: `${market.label} · ${key}`,
              before:
                key === "paymentDetails"
                  ? `${before[key].length} dato(s)`
                  : String(before[key]),
              after:
                key === "paymentDetails"
                  ? `${market[key].length} dato(s)`
                  : String(market[key]),
            },
          ],
    );
  });
  return [
    ...rootChanges,
    ...automationChanges,
    ...riskChanges,
    ...marketChanges,
  ];
}
