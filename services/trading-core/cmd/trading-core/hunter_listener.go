package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// listenHunterEvents mantiene una conexión dedicada a LISTEN hunter_events y
// despierta al consumidor en cuanto el hunter inserta un evento. Si la conexión
// cae, se reconecta sin bloquear el bucle principal.
func listenHunterEvents(
	ctx context.Context,
	databaseURL string,
	wake chan<- struct{},
	logger *slog.Logger,
) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		if logger != nil {
			logger.Warn("LISTEN hunter_events deshabilitado: URL inválida", "error", err)
		}
		return
	}
	for ctx.Err() == nil {
		conn, err := pgx.ConnectConfig(ctx, poolConfig.ConnConfig)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if logger != nil {
				logger.Warn("LISTEN hunter_events no pudo conectar", "error", err)
			}
			sleepContext(ctx, time.Second)
			continue
		}
		if _, err := conn.Exec(ctx, "LISTEN hunter_events"); err != nil {
			_ = conn.Close(ctx)
			if logger != nil {
				logger.Warn("LISTEN hunter_events falló", "error", err)
			}
			sleepContext(ctx, time.Second)
			continue
		}
		if logger != nil {
			logger.Info("LISTEN hunter_events activo")
		}
		for {
			if _, err := conn.WaitForNotification(ctx); err != nil {
				break
			}
			select {
			case wake <- struct{}{}:
			default:
			}
		}
		_ = conn.Close(ctx)
		if ctx.Err() != nil {
			return
		}
		sleepContext(ctx, time.Second)
	}
}

func sleepContext(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
