// Servicio notifier: recibe alertas internas y las envía a Telegram.
// No hace long-polling, no procesa comandos y por defecto opera en dry-run.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

const (
	defaultPort = "8092"
	maxBody     = 16 << 10
)

type config struct {
	Port        string
	BaseURL     string
	Token       string
	ChatID      string
	InternalKey string
	DryRun      bool
}

func loadConfig() (config, error) {
	cfg := config{
		Port:        envOrDefault("PORT", defaultPort),
		BaseURL:     envOrDefault("TELEGRAM_API_BASE_URL", "https://api.telegram.org"),
		Token:       strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN")),
		ChatID:      strings.TrimSpace(os.Getenv("TELEGRAM_CHAT_ID")),
		InternalKey: strings.TrimSpace(os.Getenv("NOTIFIER_INTERNAL_TOKEN")),
		DryRun:      true,
	}
	if raw := strings.TrimSpace(os.Getenv("NOTIFIER_DRY_RUN")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return config{}, fmt.Errorf("NOTIFIER_DRY_RUN inválido")
		}
		cfg.DryRun = value
	}
	port, err := strconv.Atoi(cfg.Port)
	if err != nil || port < 1 || port > 65535 {
		return config{}, fmt.Errorf("PORT inválido")
	}
	return cfg, nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("notifier terminó con error", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	client := notifier.NewClient(cfg.Token, cfg.BaseURL)
	service := &service{cfg: cfg, client: client, dedupe: notifier.NewDeduper(10 * time.Minute), logger: logger}
	server := &http.Server{
		Addr: ":" + cfg.Port, Handler: service,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()
	logger.Info("notifier iniciado", "port", cfg.Port, "dry_run", cfg.DryRun)
	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

type service struct {
	cfg    config
	client *notifier.Client
	dedupe *notifier.Deduper
	logger *slog.Logger

	requests atomic.Uint64
	sent     atomic.Uint64
	deduped  atomic.Uint64
	errors   atomic.Uint64
}

type notifyRequest struct {
	Text      string `json:"text"`
	ChatID    string `json:"chatId"`
	DedupeKey string `json:"dedupeKey"`
}

func (service *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	service.requests.Add(1)
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/healthz":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case r.Method == http.MethodGet && r.URL.Path == "/readyz":
		service.readyz(w)
	case r.Method == http.MethodGet && r.URL.Path == "/metrics":
		service.metrics(w)
	case r.Method == http.MethodPost && r.URL.Path == "/notify":
		service.notify(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
	}
}

func (service *service) readyz(w http.ResponseWriter) {
	if service.cfg.DryRun {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "mode": "dry_run"})
		return
	}
	if service.cfg.Token == "" || service.cfg.ChatID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "telegram sin token/chat"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (service *service) notify(w http.ResponseWriter, r *http.Request) {
	if service.cfg.InternalKey != "" && r.Header.Get("X-Notifier-Token") != service.cfg.InternalKey {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthorized"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "bad_request"})
		return
	}
	var request notifyRequest
	if err := json.Unmarshal(body, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "bad_request"})
		return
	}
	request.Text = strings.TrimSpace(request.Text)
	if request.Text == "" || len(request.Text) > 4096 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "bad_request", "error": "texto inválido"})
		return
	}
	if service.dedupe.Seen(request.DedupeKey) {
		service.deduped.Add(1)
		writeJSON(w, http.StatusOK, map[string]string{"status": "duplicate"})
		return
	}
	if service.cfg.DryRun {
		service.sent.Add(1)
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "dry_run"})
		return
	}
	chatID := strings.TrimSpace(request.ChatID)
	if chatID == "" {
		chatID = service.cfg.ChatID
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := service.client.SendMessage(ctx, chatID, request.Text); err != nil {
		service.errors.Add(1)
		service.logger.Warn("envío Telegram falló", "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"status": "telegram_error"})
		return
	}
	service.sent.Add(1)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "sent"})
}

func (service *service) metrics(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprintf(w, "# HELP notifier_requests_total Peticiones HTTP.\n# TYPE notifier_requests_total counter\nnotifier_requests_total %d\n", service.requests.Load())
	fmt.Fprintf(w, "# HELP notifier_sent_total Notificaciones enviadas o simuladas.\n# TYPE notifier_sent_total counter\nnotifier_sent_total %d\n", service.sent.Load())
	fmt.Fprintf(w, "# HELP notifier_deduped_total Notificaciones deduplicadas.\n# TYPE notifier_deduped_total counter\nnotifier_deduped_total %d\n", service.deduped.Load())
	fmt.Fprintf(w, "# HELP notifier_errors_total Errores de envío.\n# TYPE notifier_errors_total counter\nnotifier_errors_total %d\n", service.errors.Load())
}

func healthcheck() int {
	port := envOrDefault("PORT", defaultPort)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
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

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
