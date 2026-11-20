package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

// liveMutations adapta el cliente HTTP de mutaciones al contrato del edge.
// Sólo se construye cuando EDGE_MUTATIONS_LIVE=true.
type liveMutations struct {
	client *qvapay.MutationClient
}

func (live *liveMutations) CreateOffer(ctx context.Context, payload map[string]any) (map[string]any, error) {
	result, err := live.client.CreateOffer(ctx, payload)
	if err != nil {
		return nil, err
	}
	var body struct {
		P2P struct {
			UUID string `json:"uuid"`
		} `json:"p2p"`
	}
	if len(result.Body) > 0 {
		if err := json.Unmarshal(result.Body, &body); err != nil {
			return nil, fmt.Errorf("respuesta de creación inválida: %w", err)
		}
	}
	if body.P2P.UUID == "" {
		return nil, fmt.Errorf("QvaPay no devolvió la oferta creada")
	}
	return map[string]any{"uuid": body.P2P.UUID}, nil
}

func (live *liveMutations) EditOffer(ctx context.Context, offerUUID string, payload map[string]any) error {
	_, err := live.client.EditOffer(ctx, offerUUID, payload)
	return err
}

func (live *liveMutations) CancelOffer(ctx context.Context, offerUUID, order string) error {
	_, err := live.client.Cancel(ctx, offerUUID, order)
	return err
}

func (live *liveMutations) MarkPaid(ctx context.Context, offerUUID, order, txID string) error {
	_, err := live.client.MarkPaid(ctx, offerUUID, order, txID)
	return err
}

func (live *liveMutations) ConfirmReceived(ctx context.Context, offerUUID, order string) error {
	_, err := live.client.ConfirmReceived(ctx, offerUUID, order)
	return err
}
