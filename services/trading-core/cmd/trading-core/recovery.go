package main

import (
	"context"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

// recoverStaleOperations rescata operaciones que quedaron a medias por un
// reinicio. Las reserved nunca llegaron a enviarse: se reencolan si el evento
// original todavía permite aplicar. Las submitted pudieron enviarse, así que
// se marcan inciertas y las resuelve el conciliador contra QvaPay.
func (consumer *hunterConsumer) recoverStaleOperations(ctx context.Context) {
	if consumer == nil || consumer.pool == nil || consumer.operationRepo == nil {
		return
	}
	rows, err := consumer.pool.Query(ctx, `
		SELECT o.operation_id, o.state, o.qusd_amount, o.fiat_amount, o.updated_at,
		       d.offer_uuid, d.coin, d.side, d.hunter_decision, d.rate, d.created_at,
		       COALESCE(e.payload_json, '')
		FROM shadow.core_operations o
		JOIN shadow.core_decisions d ON d.event_id = o.operation_id
		LEFT JOIN shadow.hunter_events e ON e.event_id = o.operation_id
		WHERE o.state IN ('reserved', 'submitted')
		ORDER BY o.updated_at ASC
		LIMIT 100`)
	if err != nil {
		if consumer.logger != nil {
			consumer.logger.Warn("no se pudieron buscar operaciones a medias", "error", err)
		}
		return
	}
	defer rows.Close()

	type stale struct {
		operationID, state, offerUUID, coin, side, decision, rate, payload string
		amountText, receiveText                                            string
		updatedAt, observedAt                                              int64
	}
	pending := make([]stale, 0, 16)
	for rows.Next() {
		var item stale
		if err := rows.Scan(
			&item.operationID, &item.state, &item.amountText, &item.receiveText,
			&item.updatedAt, &item.offerUUID, &item.coin, &item.side,
			&item.decision, &item.rate, &item.observedAt, &item.payload,
		); err != nil {
			if consumer.logger != nil {
				consumer.logger.Warn("no se pudo leer una operación a medias", "error", err)
			}
			continue
		}
		pending = append(pending, item)
	}
	if err := rows.Err(); err != nil {
		if consumer.logger != nil {
			consumer.logger.Warn("error recorriendo operaciones a medias", "error", err)
		}
	}

	for _, item := range pending {
		if item.state == string(core.StateSubmitted) {
			if _, err := consumer.operationRepo.Transition(
				ctx, item.operationID, core.StateUncertain, postgres.NowMS(),
			); err != nil {
				if consumer.logger != nil {
					consumer.logger.Warn("no se pudo marcar incierta una operación enviada",
						"operation_id", item.operationID, "error", err)
				}
			} else if consumer.logger != nil {
				consumer.logger.Warn("operación enviada sin confirmar marcada incierta",
					"operation_id", item.operationID)
			}
			continue
		}
		if consumer.trader == nil {
			if _, err := consumer.operationRepo.Transition(
				ctx, item.operationID, core.StateRejected, postgres.NowMS(),
			); err != nil && consumer.logger != nil {
				consumer.logger.Warn("no se pudo rechazar una operación reservada sin motor live",
					"operation_id", item.operationID, "error", err)
			}
			continue
		}
		payload, ok := recoveryPayload(item.payload, item.offerUUID, item.coin, item.side,
			item.decision, item.amountText, item.receiveText, item.rate, item.observedAt)
		if !ok {
			if _, err := consumer.operationRepo.Transition(
				ctx, item.operationID, core.StateRejected, postgres.NowMS(),
			); err != nil && consumer.logger != nil {
				consumer.logger.Warn("no se pudo rechazar una operación reservada sin payload",
					"operation_id", item.operationID, "error", err)
			}
			continue
		}
		amount, err := decimal.Parse(item.amountText)
		if err != nil || amount.Sign() <= 0 {
			continue
		}
		receive, err := decimal.Parse(item.receiveText)
		if err != nil || receive.Sign() <= 0 {
			continue
		}
		task := executionTask{
			eventID: item.operationID, payload: payload,
			amount: amount, receive: receive,
			flexible: payload.OfferKind == "flexible",
		}
		select {
		case consumer.applyQueue <- task:
			if consumer.logger != nil {
				consumer.logger.Info("operación reservada reencolada tras reinicio",
					"operation_id", item.operationID, "offer_uuid", item.offerUUID)
			}
		case <-ctx.Done():
			return
		}
	}
}

// recoveryPayload reconstruye el payload del hunter desde el evento original.
// Si el evento no está disponible, fabrica uno mínimo con la decisión.
func recoveryPayload(
	raw, offerUUID, coin, side, decision, amount, receive, rate string,
	observedAt int64,
) (hunterPayload, bool) {
	if payload, err := parseHunterPayload(raw); err == nil {
		if payload.OfferUUID == "" {
			payload.OfferUUID = offerUUID
		}
		if payload.Coin == "" {
			payload.Coin = coin
		}
		if payload.Side == "" {
			payload.Side = side
		}
		if payload.Decision == "" {
			payload.Decision = decision
		}
		if payload.Amount == "" {
			payload.Amount = amount
		}
		if payload.Receive == "" {
			payload.Receive = receive
		}
		if payload.Rate == "" {
			payload.Rate = rate
		}
		if payload.ObservedAt <= 0 {
			payload.ObservedAt = observedAt
		}
		if payload.Source == "" {
			payload.Source = "recovery"
		}
		return payload, payload.OfferUUID != "" && payload.Coin != "" &&
			payload.Side != "" && payload.Amount != "" && payload.Receive != ""
	}
	if offerUUID == "" || coin == "" || side == "" || amount == "" || receive == "" {
		return hunterPayload{}, false
	}
	return hunterPayload{
		OfferUUID: offerUUID, Coin: coin, Side: side, Decision: decision,
		Amount: amount, Receive: receive, Rate: rate,
		ObservedAt: observedAt, Source: "recovery",
	}, true
}
