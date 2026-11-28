package edge

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestQvapayWebhookForwarder(t *testing.T) {
	received := make(chan struct {
		body  string
		token string
	}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- struct {
			body  string
			token string
		}{body: string(body), token: r.Header.Get("X-Hunter-Feed-Token")}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	api := &QvapayWebhookAPI{
		ForwardURL: server.URL, ForwardToken: "secret",
		ForwardQueue: make(chan []byte, 1),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go api.RunForwarder(ctx)
	api.enqueueForward([]byte(`{"event":"p2p.created"}`))

	select {
	case got := <-received:
		if got.body != `{"event":"p2p.created"}` || got.token != "secret" {
			t.Fatalf("reenvío = %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("el forwarder no reenvió el cuerpo")
	}
}
