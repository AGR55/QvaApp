import React from "react";
import { Empty } from "./common.jsx";
import { money } from "../lib/format.js";

export function Offers({ offers, label, unit, editable = false, onEdit, onCancel }) {
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
                  <button onClick={() => onEdit?.(offer)}>
                    Editar
                  </button>
                  <button
                    className="danger-action"
                    onClick={() => onCancel?.(offer)}
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
