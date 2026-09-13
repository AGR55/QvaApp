import React from "react";
import { Empty } from "./common.jsx";
import { Badge, Button } from "./ui.jsx";
import { money } from "../lib/format.js";
import { MarketIdentity } from "./market-identity.jsx";

export function Offers({ offers, markets = [], label, unit, editable = false, onEdit, onCancel }) {
  if (!offers?.length) return <Empty>Sin ofertas.</Empty>;
  return (
    <div className="table-wrap" tabIndex="0" role="region" aria-label="Ofertas del mercado, tabla desplazable">
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
              <td><MarketIdentity market={markets.find((item) => item.code === offer.coin) || { code: offer.coin, label: label(offer.coin) }} size="sm" /></td>
              <td><Badge variant={offer.type === "buy" ? "buy" : "sell"}>{offer.type === "buy" ? "Compra" : "Venta"}</Badge></td>
              <td>{money(offer.amount)}</td>
              <td>
                {money(offer.rate, unit(offer.coin) === "USD" ? 4 : 2)}{" "}
                {unit(offer.coin)}
              </td>
              {editable ? (
                <td className="offer-actions">
                  <Button variant="outline" size="sm" onClick={() => onEdit?.(offer)}>
                    Editar
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => onCancel?.(offer)}
                  >
                    Cancelar
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
