package qvapay

import (
	"net"
	"net/http"
	"time"
)

// sharedTransport conserva más conexiones TLS ociosas que el transporte por
// defecto. El hunter, la conciliación y las mutaciones comparten host, así que
// reutilizar la conexión evita handshakes en el camino crítico del apply.
var sharedTransport = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	DialContext: (&net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	ForceAttemptHTTP2:     true,
	MaxIdleConns:          100,
	MaxIdleConnsPerHost:   32,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   5 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
}
