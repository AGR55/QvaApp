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
		}
	}

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           newHandler(cfg, readyCheck),
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

type app struct {
	cfg        config
	readyCheck func(context.Context) error
	requests   atomic.Uint64
}

// newHandler construye el router HTTP. readyCheck nil significa que no hay
// base de datos configurada y /readyz responde listo.
func newHandler(cfg config, readyCheck func(context.Context) error) http.Handler {
	a := &app{cfg: cfg, readyCheck: readyCheck}

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

func (a *app) handleMetrics(w http.ResponseWriter, _ *http.Request) {
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
