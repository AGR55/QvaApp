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

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

const (
	defaultPort = "8092"
	maxBody     = 16 << 10
)

type config struct {
	Port            string
	DatabaseURL     string
	BaseURL         string
	Token           string
	ChatID          string
	AdminChatID     int64
	InternalKey     string
	TelegramSecret  string
	WebhookURL      string
	WebhookEnabled  bool
	WebPushPublic   string
	WebPushPrivate  string
	WebPushSubject  string
	PushSendEnabled bool
	PollingEnabled  bool
	EdgeURL         string
	EdgePassword    string
	EdgeOrigin      string
	DryRun          bool
}

func loadConfig() (config, error) {
	cfg := config{
		Port:           envOrDefault("PORT", defaultPort),
		DatabaseURL:    strings.TrimSpace(os.Getenv("DATABASE_URL")),
		BaseURL:        envOrDefault("TELEGRAM_API_BASE_URL", "https://api.telegram.org"),
		Token:          strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN")),
		ChatID:         strings.TrimSpace(os.Getenv("TELEGRAM_CHAT_ID")),
		InternalKey:    strings.TrimSpace(os.Getenv("NOTIFIER_INTERNAL_TOKEN")),
		TelegramSecret: strings.TrimSpace(os.Getenv("NOTIFIER_TELEGRAM_SECRET")),
		WebhookURL:     strings.TrimSpace(os.Getenv("TELEGRAM_WEBHOOK_URL")),
		WebPushPublic:  strings.TrimSpace(os.Getenv("WEB_PUSH_PUBLIC_KEY")),
		WebPushPrivate: strings.TrimSpace(os.Getenv("WEB_PUSH_PRIVATE_KEY")),
		WebPushSubject: strings.TrimSpace(os.Getenv("WEB_PUSH_SUBJECT")),
		EdgeURL:        envOrDefault("EDGE_URL", "http://edge:8093"),
		EdgePassword:   strings.TrimSpace(os.Getenv("EDGE_ADMIN_PASSWORD")),
		EdgeOrigin:     envOrDefault("EDGE_ORIGIN", "https://qvapply.honux.tech"),
		DryRun:         true,
	}
	if raw := strings.TrimSpace(os.Getenv("TELEGRAM_POLLING_ENABLED")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return config{}, fmt.Errorf("TELEGRAM_POLLING_ENABLED inválido")
		}
		cfg.PollingEnabled = value
	}
	if raw := strings.TrimSpace(os.Getenv("TELEGRAM_ADMIN_CHAT_ID")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return config{}, fmt.Errorf("TELEGRAM_ADMIN_CHAT_ID inválido")
		}
		cfg.AdminChatID = value
	}
	if raw := strings.TrimSpace(os.Getenv("PUSH_SEND_ENABLED")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return config{}, fmt.Errorf("PUSH_SEND_ENABLED inválido")
		}
		cfg.PushSendEnabled = value
	}
	if raw := strings.TrimSpace(os.Getenv("TELEGRAM_WEBHOOK_ENABLED")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return config{}, fmt.Errorf("TELEGRAM_WEBHOOK_ENABLED inválido")
		}
		cfg.WebhookEnabled = value
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client := notifier.NewClient(cfg.Token, cfg.BaseURL)
	var pushStore notifier.PushSubscriptionStore
	var pool *pgxpool.Pool
	if cfg.DatabaseURL != "" {
		pool, err = pgxpool.New(ctx, cfg.DatabaseURL)
		if err == nil {
			defer pool.Close()
			pushStore = postgres.NewPushSubscriptionRepository(pool)
		} else {
			logger.Warn("Postgres push no disponible; usando store en memoria", "error", err)
		}
	}
	if pushStore == nil {
		logger.Warn("push persistente deshabilitado: Postgres no configurado")
	}
	var pushSender notifier.PushSender
	if cfg.WebPushPublic != "" && cfg.WebPushPrivate != "" {
		sender, err := notifier.NewWebPushSender(notifier.VAPIDConfig{
			PublicKey: cfg.WebPushPublic, PrivateKey: cfg.WebPushPrivate, Subject: cfg.WebPushSubject,
		})
		if err != nil {
			logger.Warn("push sender deshabilitado: VAPID inválido", "error", err)
		} else {
			if cfg.PushSendEnabled {
				sender.Enable()
			}
			pushSender = sender
		}
	}
	service := &service{
		cfg: cfg, client: client, dedupe: notifier.NewDeduper(10 * time.Minute),
		logger: logger, pushAPI: &notifier.PushAPI{Store: pushStore, InternalToken: cfg.InternalKey},
		pushService: &notifier.PushService{Sender: pushSender, Store: pushStore, InternalToken: cfg.InternalKey},
		webhookAdmin: &notifier.WebhookAdmin{
			Client: client, InternalToken: cfg.InternalKey,
			Registration: notifier.WebhookRegistration{
				PublicURL: cfg.WebhookURL, Secret: cfg.TelegramSecret,
				AllowedUpdates: []string{"message", "callback_query"},
				Enabled:        cfg.WebhookEnabled,
			},
		},
	}
	if cfg.PollingEnabled && !cfg.DryRun && cfg.Token != "" && cfg.AdminChatID != 0 && cfg.EdgePassword != "" {
		runtime := &telegramRuntime{
			client: client, edge: newEdgeClient(cfg.EdgeURL, cfg.EdgeOrigin, cfg.EdgePassword),
			adminChatID: cfg.AdminChatID, logger: logger,
		}
		service.telegram = runtime
		go runtime.Run(ctx)
		logger.Info("telegram long polling habilitado", "edge", cfg.EdgeURL)
	} else if cfg.PollingEnabled {
		logger.Warn("telegram polling no iniciado: faltan token, chat, contraseña del edge o dry-run activo")
	}
	server := &http.Server{
		Addr: ":" + cfg.Port, Handler: service,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
	}
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

	pushAPI      *notifier.PushAPI
	pushService  *notifier.PushService
	webhookAdmin *notifier.WebhookAdmin
	telegram     *telegramRuntime
	requests     atomic.Uint64
	sent         atomic.Uint64
	deduped      atomic.Uint64
	errors       atomic.Uint64
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
	case r.Method == http.MethodPost && r.URL.Path == "/telegram/update":
		service.telegramUpdate(w, r)
	case strings.HasPrefix(r.URL.Path, "/admin/telegram"):
		service.webhookAdmin.ServeHTTP(w, r)
	case r.URL.Path == "/push/subscriptions":
		service.pushAPI.ServeHTTP(w, r)
	case r.URL.Path == "/push/send":
		service.pushService.ServeHTTP(w, r)
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

func (service *service) telegramUpdate(w http.ResponseWriter, r *http.Request) {
	if service.cfg.TelegramSecret != "" && r.Header.Get("X-Telegram-Bot-Api-Secret-Token") != service.cfg.TelegramSecret {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthorized"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10+1))
	if err != nil || len(body) > 64<<10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "bad_request"})
		return
	}
	update, ok := notifier.ParseUpdate(body)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_update"})
		return
	}
	if service.telegram != nil {
		reply, handled := service.telegram.handle(r.Context(), update)
		if handled {
			service.sent.Add(1)
			writeJSON(w, http.StatusAccepted, map[string]any{"status": "handled", "reply": reply})
			return
		}
	}
	result := notifier.HandleUpdate(update, notifier.Authorization{AdminChatID: service.cfg.AdminChatID})
	menu := notifier.MenuForAction(result.Decision.Action, result.Decision.Mutation)
	payload := map[string]any{
		"updateId": result.UpdateID, "chatId": result.ChatID,
		"action": result.Decision.Action, "mutation": result.Decision.Mutation,
		"reply": result.Reply, "menu": menu,
	}
	if service.cfg.DryRun {
		service.sent.Add(1)
		writeJSON(w, http.StatusAccepted, payload)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := service.client.SendMenu(ctx, strconv.FormatInt(result.ChatID, 10), result.Reply,
		notifier.KeyboardFromMenu(menu)); err != nil {
		service.errors.Add(1)
		service.logger.Warn("respuesta Telegram falló", "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"status": "telegram_error"})
		return
	}
	service.sent.Add(1)
	writeJSON(w, http.StatusAccepted, payload)
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
