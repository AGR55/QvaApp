import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, History, ImagePlus, Plus, Save, Trash2, X } from "lucide-react";
import { Empty, Panel, Skeleton, ViewHead } from "../components/common.jsx";
import { requestJson } from "../lib/http.js";
import { useDialog } from "../hooks/use-dialog.js";
import { Button, Input, Textarea } from "../components/ui.jsx";

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
  ["scanIntervalSeconds", "Intervalo de escaneo", "segundos", 5],
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
  const dialogRef = useDialog(reviewing, closeReview);

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
        kicker="Configuración activa"
        title="Estrategia"
        description="Límites de riesgo, comportamiento del bot y mercados. Cada cambio se revisa y queda auditado."
      />
      <Panel title="Límites de riesgo" kicker="Protección" wide>
        <form
          className="settings-form"
          onSubmit={(event) => event.preventDefault()}
        >
          <label>
            Máximo de ofertas propias
            <span className="input-unit">
              <Input
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
          </label>
          {riskFields.map(([key, label, unit]) => (
            <label key={key}>
              {label}
              <span className="input-unit">
                <Input
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
            </label>
          ))}
          <div className="form-actions" aria-live="polite">
            <Button
              type="button"
              variant="primary"
              disabled={!changes.length && !requiresInitialReview}
              onClick={() => setReviewing(true)}
            >
              <Save aria-hidden="true" />{" "}
              {requiresInitialReview && !changes.length
                ? "Revisar y aprobar límites"
                : `Revisar ${changes.length} cambio(s)`}
            </Button>
            <span>{status}</span>
          </div>
        </form>
      </Panel>

      <Panel title="Comportamiento del bot" kicker="Ritmo" wide>
        <form
          className="settings-form"
          onSubmit={(event) => event.preventDefault()}
        >
          {automationFields.map(([key, label, unit, minimum]) => (
            <label key={key}>
              {label}
              <span className="input-unit">
                <Input
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
            </label>
          ))}
          <label className="message-setting">
            Mensaje automático en el chat P2P
            <Textarea
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
          </label>
        </form>
      </Panel>

      <Panel title="Mercados y precios" kicker="Terreno" wide>
        <div className="market-settings-grid">
          {draft.markets.map((market, index) => (
            <fieldset key={market.code} className="market-settings">
              <legend>{market.label}</legend>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={market.active}
                  onChange={(event) =>
                    updateMarket(index, "active", event.target.checked)
                  }
                />
                Mercado activo
              </label>
              <label>
                Código QvaPay
                <Input
                  value={market.code}
                  onChange={(event) =>
                    updateMarket(
                      index,
                      "code",
                      event.target.value.toUpperCase(),
                    )
                  }
                />
              </label>
              <label>
                Nombre visible
                <Input
                  value={market.label}
                  onChange={(event) =>
                    updateMarket(index, "label", event.target.value)
                  }
                />
              </label>
              <MarketIconEditor
                market={market}
                onChange={(iconUrl) => updateMarket(index, "iconUrl", iconUrl)}
              />
              <label>
                Color identificativo
                <span className="market-color-field">
                  <input
                    type="color"
                    value={market.color || "#6f8494"}
                    onChange={(event) =>
                      updateMarket(index, "color", event.target.value)
                    }
                  />
                  <code>{market.color || "#6f8494"}</code>
                </span>
              </label>
              <label>
                Moneda fiat
                <Input
                  value={market.currency}
                  onChange={(event) =>
                    updateMarket(
                      index,
                      "currency",
                      event.target.value.toUpperCase(),
                    )
                  }
                />
              </label>
              <label>
                Saldo fiat declarado
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={market.fiatBalance}
                  onChange={(event) =>
                    updateMarket(index, "fiatBalance", event.target.value)
                  }
                />
              </label>
              <label>
                Máximo de compra
                <Input
                  type="number"
                  min="0.0000001"
                  step="0.0001"
                  value={market.buyMaxRate}
                  onChange={(event) =>
                    updateMarket(index, "buyMaxRate", event.target.value)
                  }
                />
              </label>
              <label>
                Mínimo de venta
                <Input
                  type="number"
                  min="0.0000001"
                  step="0.0001"
                  value={market.sellMinRate}
                  onChange={(event) =>
                    updateMarket(index, "sellMinRate", event.target.value)
                  }
                />
              </label>
              <label>
                Máximo QUSD por compra
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={market.purchaseMaxQusd}
                  onChange={(event) =>
                    updateMarket(index, "purchaseMaxQusd", event.target.value)
                  }
                />
              </label>
              <label>
                Comisión de venta (%)
                <Input
                  type="number"
                  min="0"
                  max="99.99"
                  step="0.01"
                  value={market.sellFeePercent}
                  onChange={(event) =>
                    updateMarket(index, "sellFeePercent", event.target.value)
                  }
                />
              </label>
              <label>
                Comisión fija de salida
                <span className="input-unit">
                  <Input
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
              </label>
              <div className="payment-details">
                <strong>Datos de cobro</strong>
                {market.paymentDetails.map((detail, detailIndex) => (
                  <div key={detailIndex}>
                    <Input
                      aria-label={`Nombre del dato ${detailIndex + 1}`}
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
                    <Input
                      aria-label={`Valor del dato ${detailIndex + 1}`}
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
                  <Plus aria-hidden="true" /> Añadir dato
                </Button>
              </div>
              <Button
                variant="destructive"
                size="sm"
                type="button"
                onClick={() => removeMarket(index)}
              >
                <Trash2 aria-hidden="true" /> Eliminar mercado
              </Button>
            </fieldset>
          ))}
        </div>
        <Button
          variant="primary"
          type="button"
          className="add-market"
          onClick={addMarket}
        >
          <Plus aria-hidden="true" /> Añadir mercado
        </Button>
      </Panel>

      {reviewing ? (
        <section
          ref={dialogRef}
          className="review-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="review-title"
        >
          <div>
            <p className="eyebrow">CONFIRMACIÓN CRÍTICA</p>
            <h2 id="review-title">Revisa el impacto antes de activar</h2>
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
            <label className="reason-field">
              Motivo de la revisión
              <Input
                value={reason}
                minLength="5"
                required
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="review-actions">
              <Button variant="ghost" type="button" onClick={closeReview}>
                Volver
              </Button>
              <Button
                variant="primary"
                type="button"
                disabled={reason.trim().length < 5}
                onClick={save}
              >
                <Check aria-hidden="true" /> Confirmar y activar
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <Panel title="Historial de revisiones" kicker="Versiones" wide>
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
      const base64 = await fileBase64(file);
      const payload = await requestJson("/api/market-icons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          mimeType: file.type || imageMimeFromName(file.name),
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
          <ImagePlus aria-hidden="true" />
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
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          aria-label={`Seleccionar icono para ${market.label}`}
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={(event) => void choose(event)}
        />
      </div>
      <small>PNG, WebP, JPEG o SVG seguro · máximo 512 KB</small>
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
