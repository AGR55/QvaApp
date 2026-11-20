package main

import (
	"context"
	"errors"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

type fakeRuntimeConfig struct {
	config runtimeconfig.Config
	err    error
}

func (loader fakeRuntimeConfig) Load(context.Context) (runtimeconfig.Config, int64, error) {
	return loader.config, 1, loader.err
}

type fakeOperationChat struct {
	calls   int
	offer   string
	order   string
	message string
	err     error
}

func (chat *fakeOperationChat) SendChat(
	_ context.Context, offerUUID, order, message string,
) (qvapay.ChatMessage, error) {
	chat.calls++
	chat.offer, chat.order, chat.message = offerUUID, order, message
	if chat.err != nil {
		return qvapay.ChatMessage{}, chat.err
	}
	return qvapay.ChatMessage{ID: "message-1"}, nil
}

func TestSendApplyMessageUsaElMensajeConfigurado(t *testing.T) {
	chat := &fakeOperationChat{}
	consumer := &hunterConsumer{
		chat: chat,
		runtime: fakeRuntimeConfig{config: runtimeconfig.Config{
			Automation: runtimeconfig.Automation{WelcomeMessage: "  Oferta tomada por un bot  "},
		}},
	}
	consumer.sendApplyMessage(context.Background(), "op-1", "offer-1", "order-1")
	if chat.calls != 1 {
		t.Fatalf("calls = %d", chat.calls)
	}
	if chat.offer != "offer-1" || chat.order != "order-1" || chat.message != "Oferta tomada por un bot" {
		t.Fatalf("envío inesperado: %+v", chat)
	}
}

func TestSendApplyMessageOmitidoSinMensajeOConError(t *testing.T) {
	chat := &fakeOperationChat{}
	consumer := &hunterConsumer{
		chat:    chat,
		runtime: fakeRuntimeConfig{config: runtimeconfig.Config{}},
	}
	consumer.sendApplyMessage(context.Background(), "op-1", "offer-1", "order-1")
	if chat.calls != 0 {
		t.Fatalf("no debe enviar sin mensaje: calls=%d", chat.calls)
	}

	consumer.runtime = fakeRuntimeConfig{err: errors.New("sin configuración")}
	consumer.sendApplyMessage(context.Background(), "op-1", "offer-1", "order-1")
	if chat.calls != 0 {
		t.Fatalf("no debe enviar sin configuración: calls=%d", chat.calls)
	}

	consumer.runtime = fakeRuntimeConfig{config: runtimeconfig.Config{
		Automation: runtimeconfig.Automation{WelcomeMessage: "hola"},
	}}
	consumer.chat = &fakeOperationChat{err: errors.New("QvaPay rechazó el mensaje")}
	consumer.sendApplyMessage(context.Background(), "op-1", "offer-1", "order-1")
}
