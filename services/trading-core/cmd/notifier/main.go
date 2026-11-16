// Servicio notifier: envía alertas internas y procesa comandos de Telegram
// mediante long polling o webhook durable. Por defecto opera en dry-run.
package main

import (
	"context"
	"crypto/subtle"
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
	if cfg.WebhookEnabled && cfg.TelegramSecret == "" {
		return config{}, errors.New("NOTIFIER_TELEGRAM_SECRET requerido con TELEGRAM_WEBHOOK_ENABLED")
	}
	if cfg.WebhookEnabled && cfg.PollingEnabled {
		return config{}, errors.New("TELEGRAM_WEBHOOK_ENABLED y TELEGRAM_POLLING_ENABLED son excluyentes")
	}
	if cfg.WebhookEnabled && cfg.DryRun {
		return config{}, errors.New("TELEGRAM_WEBHOOK_ENABLED requiere NOTIFIER_DRY_RUN=false")
	}
	if cfg.WebhookEnabled && (cfg.Token == "" || cfg.WebhookURL == "") {
		return config{}, errors.New("TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_URL requeridos con TELEGRAM_WEBHOOK_ENABLED")
	}
	if cfg.WebhookEnabled && (cfg.AdminChatID == 0 || cfg.EdgePassword == "" || cfg.InternalKey == "" || cfg.DatabaseURL == "") {
		return config{}, errors.New("webhook live requiere chat administrador, credenciales internas y Postgres")
	}
	if cfg.WebhookEnabled && len(cfg.TelegramSecret) > 256 {
		return config{}, errors.New("NOTIFIER_TELEGRAM_SECRET excede 256 caracteres")
	}
	if !cfg.DryRun && (cfg.InternalKey == "" || cfg.DatabaseURL == "") {
		return config{}, errors.New("modo live requiere NOTIFIER_INTERNAL_TOKEN y DATABASE_URL")
	}
	if cfg.PollingEnabled && !cfg.DryRun &&
		(cfg.Token == "" || cfg.AdminChatID == 0 || cfg.EdgePassword == "") {
		return config{}, errors.New("polling live requiere token Telegram, chat administrador y contraseña del edge")
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
			pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			err = pool.Ping(pingCtx)
			cancel()
		}
		if err == nil {
			defer pool.Close()
			pushStore = postgres.NewPushSubscriptionRepository(pool)
		} else {
			logger.Warn("Postgres push no disponible; usando store en memoria", "error", err)
			if pool != nil {
				pool.Close()
				pool = nil
			}
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
		logger: logger, pool: pool,
		pushAPI:     &notifier.PushAPI{Store: pushStore, InternalToken: cfg.InternalKey},
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
	if (cfg.PollingEnabled || cfg.WebhookEnabled) && !cfg.DryRun && cfg.Token != "" && cfg.AdminChatID != 0 && cfg.EdgePassword != "" && pool != nil && cfg.InternalKey != "" {
		runtime := &telegramRuntime{
			client: client, edge: newEdgeClient(cfg.EdgeURL, cfg.EdgeOrigin, cfg.EdgePassword),
			inbox:       &telegramInbox{pool: pool},
			adminChatID: cfg.AdminChatID, logger: logger,
		}
		service.telegram = runtime
		if cfg.PollingEnabled {
			go runtime.Run(ctx)
			logger.Info("telegram long polling habilitado", "edge", cfg.EdgeURL)
		} else {
			go runtime.RunWebhookInbox(ctx)
			logger.Info("procesador durable de webhook Telegram habilitado", "edge", cfg.EdgeURL)
		}
	} else if cfg.PollingEnabled || cfg.WebhookEnabled {
		logger.Warn("Telegram no iniciado: requiere token, chat, contraseña del edge, Postgres, token interno y dry-run apagado")
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
	pool   *pgxpool.Pool

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
		if !service.authorizeInternal(w, r) {
			return
		}
		service.webhookAdmin.ServeHTTP(w, r)
	case r.URL.Path == "/push/subscriptions":
		if !service.authorizeInternal(w, r) {
			return
		}
		service.pushAPI.ServeHTTP(w, r)
	case r.URL.Path == "/push/send":
		if !service.authorizeInternal(w, r) {
			return
		}
		service.pushService.ServeHTTP(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
	}
}

func (service *service) authorizeInternal(w http.ResponseWriter, r *http.Request) bool {
	if service.cfg.InternalKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "internal_auth_unconfigured"})
		return false
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Notifier-Token")), []byte(service.cfg.InternalKey)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthorized"})
		return false
	}
	return true
}

func (service *service) readyz(w http.ResponseWriter) {
	if service.cfg.DryRun {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "mode": "dry_run"})
		return
	}
	if service.pool == nil || service.cfg.InternalKey == "" || service.cfg.Token == "" || service.cfg.ChatID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "telegram, Postgres o autenticación interna no configurados"})
		return
	}
	if (service.cfg.PollingEnabled || service.cfg.WebhookEnabled) && service.telegram == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "procesador de Telegram no iniciado"})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := service.pool.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "Postgres no disponible"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (service *service) notify(w http.ResponseWriter, r *http.Request) {
	if !service.authorizeInternal(w, r) {
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
	if service.cfg.DryRun {
		if service.dedupe.Seen(request.DedupeKey) {
			service.deduped.Add(1)
			writeJSON(w, http.StatusOK, map[string]string{"status": "duplicate"})
			return
		}
		service.sent.Add(1)
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "dry_run"})
		return
	}
	dedupeKey := strings.TrimSpace(request.DedupeKey)
	if dedupeKey == "" || len(dedupeKey) > 200 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "dedupe_key_required"})
		return
	}
	if service.pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "durable_dedupe_unavailable"})
		return
	}
	claimCtx, claimCancel := context.WithTimeout(r.Context(), 2*time.Second)
	claimed, err := service.claimNotification(claimCtx, dedupeKey)
	claimCancel()
	if err != nil {
		service.errors.Add(1)
		service.logger.Warn("reclamar clave de notificación falló", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "dedupe_store_unavailable"})
		return
	}
	if !claimed {
		service.deduped.Add(1)
		writeJSON(w, http.StatusOK, map[string]string{"status": "duplicate"})
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
	if !service.cfg.WebhookEnabled {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if service.cfg.TelegramSecret == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "webhook_secret_unavailable"})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Telegram-Bot-Api-Secret-Token")), []byte(service.cfg.TelegramSecret)) != 1 {
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
	if service.telegram == nil || service.telegram.inbox == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "telegram_processor_unavailable"})
		return
	}
	_, stored, err := service.telegram.inbox.Store(r.Context(), []json.RawMessage{body})
	if err != nil || !stored {
		service.errors.Add(1)
		service.logger.Warn("no se pudo persistir update de webhook Telegram", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "telegram_inbox_unavailable"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "updateId": update.UpdateID})
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
