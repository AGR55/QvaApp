// Servicio edge: estáticos y resumen de sólo lectura para web y Android.
// No autentica, no muta estado ni hace proxy al monolito TS.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/edge"
)

const (
	defaultPort     = "8093"
	defaultStatic   = "web"
	shutdownTimeout = 10 * time.Second
	statsTimeout    = 2 * time.Second
)

type config struct {
	Port        string
	StaticDir   string
	DatabaseURL string
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("edge terminó con error", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var stats edge.StatsFunc
	var pool *pgxpool.Pool
	if cfg.DatabaseURL == "" {
		logger.Info("DATABASE_URL no configurada; resumen deshabilitado")
	} else {
		pool, err = openStatsPool(ctx, cfg.DatabaseURL)
		if err != nil {
			// Sin base de datos el borde sigue sirviendo estáticos y salud.
			logger.Warn("Postgres no disponible; /api/edge/summary responderá 503", "error", err)
			pool = nil
		} else {
			defer pool.Close()
			stats = postgresStats(pool)
		}
	}
	if info, err := os.Stat(cfg.StaticDir); err != nil || !info.IsDir() {
		logger.Warn("directorio estático no encontrado", "static_dir", cfg.StaticDir)
	}

	base := edge.NewHandler(cfg.StaticDir, stats)
	shell := edge.NewShellHandler(cfg.StaticDir)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz", "/readyz", "/metrics", "/api/edge/summary":
			base.ServeHTTP(w, r)
		default:
			shell.ServeHTTP(w, r)
		}
	})
	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()

	logger.Info("edge iniciado", "port", cfg.Port, "static_dir", cfg.StaticDir, "stats", stats != nil)
	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

func loadConfig() (config, error) {
	cfg := config{
		Port:        envOrDefault("PORT", defaultPort),
		StaticDir:   envOrDefault("STATIC_DIR", defaultStatic),
		DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")),
	}
	port, err := strconv.Atoi(cfg.Port)
	if err != nil || port < 1 || port > 65535 {
		return config{}, errors.New("PORT inválido")
	}
	return cfg, nil
}

// openStatsPool abre un pool con la sesión en sólo lectura para que cualquier
// consulta accidental de escritura falle en el servidor.
func openStatsPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	poolConfig.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	poolConfig.MaxConns = 4
	poolConfig.MinConns = 0
	poolConfig.MaxConnLifetime = 30 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func postgresStats(pool *pgxpool.Pool) edge.StatsFunc {
	return func(ctx context.Context) (edge.Summary, error) {
		ctx, cancel := context.WithTimeout(ctx, statsTimeout)
		defer cancel()
		var summary edge.Summary
		err := pool.QueryRow(ctx, `
			SELECT
				(SELECT count(*) FROM shadow.hunter_events),
				(SELECT count(*) FROM shadow.core_decisions WHERE allowed),
				(SELECT count(*) FROM shadow.core_decisions WHERE NOT allowed),
				(SELECT count(*) FROM shadow.hunter_events
				 WHERE state IN ('pending', 'failed'))`,
		).Scan(
			&summary.HunterEvents, &summary.CoreAllowed,
			&summary.CoreBlocked, &summary.CorePending,
		)
		if err != nil {
			return edge.Summary{}, err
		}
		return summary, nil
	}
}

func healthcheck() int {
	port := envOrDefault("PORT", defaultPort)
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
