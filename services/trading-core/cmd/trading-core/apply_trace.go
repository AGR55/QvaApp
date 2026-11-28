package main

import (
	"context"
	"net/http/httptrace"
	"sync"
	"time"
)

// applyTrace registra los tramos de una aplicación real: cuándo sale la
// petición, si reutilizó una conexión TLS abierta y cuánto tarda la respuesta.
// Es solo observabilidad; no cambia el envío.
type applyTrace struct {
	mu             sync.Mutex
	dispatchedAt   time.Time
	getConnAt      time.Time
	gotConnAt      time.Time
	connReused     bool
	firstByteAt    time.Time
	dispatchMarked bool
}

type applyTraceKey struct{}

func withApplyTrace(ctx context.Context, trace *applyTrace) context.Context {
	if trace == nil {
		return ctx
	}
	return context.WithValue(ctx, applyTraceKey{}, trace)
}

func applyTraceFrom(ctx context.Context) *applyTrace {
	trace, _ := ctx.Value(applyTraceKey{}).(*applyTrace)
	return trace
}

// clientTrace devuelve los hooks de httptrace que alimentan el registro.
func (trace *applyTrace) clientTrace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GetConn: func(string) {
			trace.mu.Lock()
			trace.getConnAt = time.Now()
			trace.mu.Unlock()
		},
		GotConn: func(info httptrace.GotConnInfo) {
			trace.mu.Lock()
			trace.gotConnAt = time.Now()
			trace.connReused = info.Reused
			trace.mu.Unlock()
		},
		GotFirstResponseByte: func() {
			trace.mu.Lock()
			trace.firstByteAt = time.Now()
			trace.mu.Unlock()
		},
	}
}

// markDispatch fija el instante de envío justo antes de la petición HTTP.
func (trace *applyTrace) markDispatch() {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	if !trace.dispatchMarked {
		trace.dispatchedAt = time.Now()
		trace.dispatchMarked = true
	}
}

type applyTiming struct {
	receiveToDispatchMS int64
	connWaitMS          int64
	connReused          bool
	firstByteMS         int64
}

// snapshot convierte las marcas en milisegundos. receivedAt es el instante en
// que el hunter recibió la oferta (epoch ms); 0 si no viene en el evento.
func (trace *applyTrace) snapshot(receivedAt int64) applyTiming {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	timing := applyTiming{connReused: trace.connReused}
	if receivedAt > 0 && !trace.dispatchedAt.IsZero() {
		timing.receiveToDispatchMS = trace.dispatchedAt.UnixMilli() - receivedAt
	}
	if !trace.getConnAt.IsZero() && !trace.gotConnAt.IsZero() {
		timing.connWaitMS = trace.gotConnAt.Sub(trace.getConnAt).Milliseconds()
	}
	if !trace.dispatchedAt.IsZero() && !trace.firstByteAt.IsZero() {
		timing.firstByteMS = trace.firstByteAt.Sub(trace.dispatchedAt).Milliseconds()
	}
	return timing
}

// gotConnInfo construye la información de conexión para pruebas y trazas.
func gotConnInfo(reused bool) httptrace.GotConnInfo {
	return httptrace.GotConnInfo{Reused: reused}
}
