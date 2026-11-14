// Servicio trading-core en modo shadow para F3.
//
// Expone únicamente superficies de operación (salud, readiness y métricas).
// No incluye endpoints de negocio ni mutaciones.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/shadow"
)

const (
	defaultPort        = "8090"
	defaultServiceName = "trading-core"
	shutdownTimeout    = 10 * time.Second
	readinessTimeout   = 3 * time.Second
)

type config struct {
	Port        string
	DatabaseURL string
	ShadowMode  bool
	ServiceName string
}

// loadConfig lee la configuración exclusivamente del entorno.
func loadConfig() (config, error) {
	cfg := config{
		Port:        envOrDefault("PORT", defaultPort),
		DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")),
		ShadowMode:  true,
		ServiceName: envOrDefault("SERVICE_NAME", defaultServiceName),
	}

	port, err := strconv.Atoi(cfg.Port)
	if err != nil || port < 1 || port > 65535 {
		return config{}, fmt.Errorf("PORT inválido: %q", cfg.Port)
	}

	if raw := strings.TrimSpace(os.Getenv("SHADOW_MODE")); raw != "" {
		shadow, err := strconv.ParseBool(raw)
		if err != nil {
			return config{}, fmt.Errorf("SHADOW_MODE inválido: %q", raw)
		}
		cfg.ShadowMode = shadow
	}

	return cfg, nil
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("trading-core terminó con error", "error", err)
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

	var readyCheck func(context.Context) error
	var shadowStats shadowStatsFunc
	if cfg.DatabaseURL != "" {
		pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
		if err != nil {
			// No se registra la URL para no filtrar credenciales.
			logger.Error("no se pudo crear el pool de Postgres", "error", err)
			readyCheck = func(context.Context) error {
				return errors.New("pool de Postgres no disponible")
			}
		} else {
			defer pool.Close()
			readyCheck = pool.Ping
			shadowStats = postgres.NewShadowRepository(pool).Stats
		}
	}

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           newHandler(cfg, readyCheck, shadowStats),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.ListenAndServe()
	}()

	logger.Info("trading-core iniciado",
		"service", cfg.ServiceName,
		"port", cfg.Port,
		"shadow_mode", cfg.ShadowMode,
		"database_configured", cfg.DatabaseURL != "",
	)

	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("servidor HTTP: %w", err)
	case <-ctx.Done():
		logger.Info("señal de apagado recibida", "service", cfg.ServiceName)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		_ = server.Close()
		return fmt.Errorf("apagado ordenado: %w", err)
	}

	logger.Info("trading-core detenido", "service", cfg.ServiceName)
	return nil
}

type shadowStatsFunc func(context.Context) (shadow.Stats, error)

type app struct {
	cfg         config
	readyCheck  func(context.Context) error
	shadowStats shadowStatsFunc
	requests    atomic.Uint64
}

// newHandler construye el router HTTP. readyCheck nil significa que no hay
// base de datos configurada y /readyz responde listo.
func newHandler(cfg config, readyCheck func(context.Context) error, shadowStats shadowStatsFunc) http.Handler {
	a := &app{cfg: cfg, readyCheck: readyCheck, shadowStats: shadowStats}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handleHealthz)
	mux.HandleFunc("GET /readyz", a.handleReadyz)
	mux.HandleFunc("GET /metrics", a.handleMetrics)
	mux.HandleFunc("/", a.handleNotFound)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.requests.Add(1)
		mux.ServeHTTP(w, r)
	})
}

func (a *app) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *app) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if a.readyCheck != nil {
		ctx, cancel := context.WithTimeout(r.Context(), readinessTimeout)
		defer cancel()

		if err := a.readyCheck(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{
				"status": "not_ready",
				"error":  err.Error(),
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *app) handleMetrics(w http.ResponseWriter, r *http.Request) {
	shadowMode := 0
	if a.cfg.ShadowMode {
		shadowMode = 1
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "# HELP trading_core_up Proceso trading-core en ejecución.\n")
	fmt.Fprintf(w, "# TYPE trading_core_up gauge\n")
	fmt.Fprintf(w, "trading_core_up 1\n")
	fmt.Fprintf(w, "# HELP trading_core_shadow_mode Modo shadow activo (1) o desactivado (0).\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_mode gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_mode %d\n", shadowMode)
	fmt.Fprintf(w, "# HELP trading_core_http_requests_total Total de peticiones HTTP recibidas.\n")
	fmt.Fprintf(w, "# TYPE trading_core_http_requests_total counter\n")
	fmt.Fprintf(w, "trading_core_http_requests_total %d\n", a.requests.Load())

	stats := shadow.Stats{}
	statsErr := 0
	if a.shadowStats != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		value, err := a.shadowStats(ctx)
		cancel()
		if err != nil {
			statsErr = 1
		} else {
			stats = value
		}
	}
	fmt.Fprintf(w, "# HELP trading_core_shadow_runs_total Runs shadow persistidos.\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_runs_total gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_runs_total %d\n", stats.Runs)
	fmt.Fprintf(w, "# HELP trading_core_shadow_decisions_total Decisiones shadow evaluadas.\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_decisions_total gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_decisions_total %d\n", stats.Decisions)
	fmt.Fprintf(w, "# HELP trading_core_shadow_mismatches_total Divergencias shadow detectadas.\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_mismatches_total gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_mismatches_total %d\n", stats.Mismatches)
	fmt.Fprintf(w, "# HELP trading_core_shadow_last_run_timestamp_seconds Último run shadow (Unix).\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_last_run_timestamp_seconds gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_last_run_timestamp_seconds %d\n", stats.LastRunAt)
	fmt.Fprintf(w, "# HELP trading_core_shadow_invariant_violations_total Violaciones de invariantes acumuladas.\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_invariant_violations_total gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_invariant_violations_total %d\n", stats.InvariantViolations)
	fmt.Fprintf(w, "# HELP trading_core_shadow_last_invariant_timestamp_seconds Último auditor de invariantes (Unix).\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_last_invariant_timestamp_seconds gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_last_invariant_timestamp_seconds %d\n", stats.LastInvariantAt)
	fmt.Fprintf(w, "# HELP trading_core_shadow_last_qvapay_timestamp_seconds Último snapshot QvaPay read-only (Unix).\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_last_qvapay_timestamp_seconds gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_last_qvapay_timestamp_seconds %d\n", stats.LastQvaPayAt)
	fmt.Fprintf(w, "# HELP trading_core_shadow_stats_error Error consultando estadísticas shadow.\n")
	fmt.Fprintf(w, "# TYPE trading_core_shadow_stats_error gauge\n")
	fmt.Fprintf(w, "trading_core_shadow_stats_error %d\n", statsErr)
}

func (a *app) handleNotFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
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

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
