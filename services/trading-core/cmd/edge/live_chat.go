package main

import (
	"context"

	"github.com/AGR55/QvaApp/services/trading-core/internal/edge"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type liveChat struct {
	client *qvapay.ChatClient
}

func (live *liveChat) ListChat(ctx context.Context, operationUUID, order string) ([]edge.ChatMessage, error) {
	messages, err := live.client.Chat(ctx, operationUUID, order)
	if err != nil {
		return nil, err
	}
	result := make([]edge.ChatMessage, 0, len(messages))
	for _, message := range messages {
		result = append(result, edge.ChatMessage{
			ID: message.ID, OperationUUID: operationUUID, OrderUUID: order,
			Message: message.Message, Direction: "in", CreatedAt: message.CreatedAt,
		})
	}
	return result, nil
}

func (live *liveChat) SendChat(ctx context.Context, operationUUID, order, text string) (edge.ChatMessage, error) {
	message, err := live.client.SendChat(ctx, operationUUID, order, text)
	if err != nil {
		return edge.ChatMessage{}, err
	}
	return edge.ChatMessage{
		ID: message.ID, OperationUUID: operationUUID, OrderUUID: order,
		Message: text, Direction: "out", CreatedAt: message.CreatedAt,
	}, nil
}
