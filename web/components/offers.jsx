import React from "react";
import { Empty } from "./common.jsx";
import { Inbox } from "lucide-react";
import { Badge, Button } from "./ui.jsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";
import { money } from "../lib/format.js";
import { MarketIdentity } from "./market-identity.jsx";

export function Offers({ offers, markets = [], label, unit, editable = false, onEdit, onCancel }) {
  if (!offers?.length) return <Empty title="Sin ofertas" icon={Inbox}>Este mercado todavía no tiene ofertas disponibles.</Empty>;
  return (
    <div className="table-wrap">
      <Table aria-label="Ofertas del mercado">
        <TableCaption className="sr-only">Ofertas del mercado con sus importes, tasas y acciones disponibles</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Mercado</TableHead>
            <TableHead>Lado</TableHead>
            <TableHead>QUSD</TableHead>
            <TableHead>Tasa</TableHead>
            {editable ? <TableHead>Acciones</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {offers.map((offer) => (
            <TableRow key={offer.uuid}>
              <TableCell><MarketIdentity market={markets.find((item) => item.code === offer.coin) || { code: offer.coin, label: label(offer.coin) }} size="sm" /></TableCell>
              <TableCell><Badge variant={offer.type === "buy" ? "buy" : "sell"}>{offer.type === "buy" ? "Compra" : "Venta"}</Badge></TableCell>
              <TableCell>{money(offer.amount)}</TableCell>
              <TableCell>
                {money(offer.rate, unit(offer.coin) === "USD" ? 4 : 2)}{" "}
                {unit(offer.coin)}
              </TableCell>
              {editable ? (
                <TableCell className="offer-actions">
                  <Button type="button" variant="outline" size="sm" onClick={() => onEdit?.(offer)}>
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => onCancel?.(offer)}
                  >
                    Cancelar
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
