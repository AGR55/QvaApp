import React from "react";
import { Empty } from "./common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";

export function Offers({ offers, label, unit, editable = false, onChanged }) {
  if (!offers?.length) return <Empty>Sin ofertas.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Mercado</th>
            <th>Lado</th>
            <th>QUSD</th>
            <th>Tasa</th>
            {editable ? <th>Acciones</th> : null}
          </tr>
        </thead>
        <tbody>
          {offers.map((offer) => (
            <tr key={offer.uuid}>
              <td>{label(offer.coin)}</td>
              <td>{offer.type}</td>
              <td>{money(offer.amount)}</td>
              <td>
                {money(offer.rate, unit(offer.coin) === "USD" ? 4 : 2)}{" "}
                {unit(offer.coin)}
              </td>
              {editable ? (
                <td className="offer-actions">
                  <button onClick={() => editOffer(offer, onChanged)}>
                    Editar
                  </button>
                  <button
                    className="danger-action"
                    onClick={() => cancelOffer(offer, onChanged)}
                  >
                    Cancelar
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function editOffer(offer, onChanged) {
  const amount = prompt("QUSD", offer.amount),
    rate = prompt("Tasa", offer.rate);
  if (amount === null || rate === null || !confirm("¿Guardar cambios?")) return;
  try {
    await requestJson(`/api/offers/${encodeURIComponent(offer.uuid)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: Number(amount), rate: Number(rate) }),
    });
    await onChanged?.();
  } catch (error) {
    alert(
      error instanceof Error ? error.message : "No se pudo editar la oferta.",
    );
  }
}
async function cancelOffer(offer, onChanged) {
  if (!confirm("¿Cancelar esta oferta?")) return;
  try {
    await requestJson(`/api/offers/${encodeURIComponent(offer.uuid)}`, {
      method: "DELETE",
    });
    await onChanged?.();
  } catch (error) {
    alert(
      error instanceof Error ? error.message : "No se pudo cancelar la oferta.",
    );
  }
}
