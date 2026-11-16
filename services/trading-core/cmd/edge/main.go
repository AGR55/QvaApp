// Servicio edge: estáticos, sesión y resumen de sólo lectura para web/Android.
package main

import (
	"context"
	"errors"
	"fmt"
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
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/vault"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const (
	defaultPort     = "8093"
	defaultStatic   = "web"
	shutdownTimeout = 10 * time.Second
	statsTimeout    = 2 * time.Second
)

type config struct {
	Port             string
	StaticDir        string
	DatabaseURL      string
	AdminPassword    string
	SessionSecret    string
	SecureCookies    bool
	OperatorsFile    string
	PublicPushKey    string
	ChatThreadsFile  string
	MobileAuthFile   string
	DashboardFile    string
	HealthFile       string
	ExtrasFile       string
	CooperativeFile  string
	IconsDir         string
	TrustedOrigin    string
	EncryptionKey    string
	MutationsEnabled bool
	MutationsLive    bool
	LiveDashboard    bool
	QvaToken         string
	MutationBaseURL  string
	HunterFeedURL    string
	HunterFeedToken  string
	SyncEnabled      bool
	SyncBaseURL      string
	SyncNATSUrl      string
	SyncEmail        string
	SyncPassword     string
	WebhookEnabled   bool
	WebhookSecret    string
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
	cooperativeSync := edge.NewCooperativeSync(
		cfg.SyncBaseURL, cfg.SyncNATSUrl, cfg.SyncEmail, cfg.SyncPassword,
		cfg.SyncEnabled, logger,
	)
	go cooperativeSync.Run(ctx)

	var stats edge.StatsFunc
	var pool *pgxpool.Pool
	var writePool *pgxpool.Pool
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
			writePool, err = openWritePool(ctx, cfg.DatabaseURL)
			if err != nil {
				logger.Warn("Postgres de escritura no disponible; configuración deshabilitada", "error", err)
				writePool = nil
			} else {
				defer writePool.Close()
			}
		}
	}
	if info, err := os.Stat(cfg.StaticDir); err != nil || !info.IsDir() {
		logger.Warn("directorio estático no encontrado", "static_dir", cfg.StaticDir)
	}

	base := edge.NewHandler(cfg.StaticDir, stats)
	shell := edge.NewShellHandler(cfg.StaticDir)
	staticRoutes := edge.NewStaticRoutes(cfg.StaticDir)
	staticRoutes.IconDir = cfg.IconsDir
	var session *edge.SessionHandler
	var mobile *edge.MobileAPI
	var dashboard *edge.DashboardAPI
	var observability *edge.ObservabilityAPI
	var live *edge.LiveAPI
	var configAPI *edge.ConfigAPI
	var operators *edge.OperatorsAPI
	var operations *edge.OperationsAPI
	var dashboardRead *edge.DashboardReadAPI
	var tradingAnalytics *edge.TradingAnalyticsAPI
	var huntingDiagnostics *edge.HuntingDiagnosticsAPI
	var mobileInsights *edge.MobileInsightsAPI
	var configAdmin *edge.ConfigAdminAPI
	var marketSource *edge.MarketSourceAPI
	var webExtras *edge.WebExtrasAPI
	var marketIcons *edge.MarketIconsAPI
	var decisionEvents *edge.DecisionEventsAPI
	var simulation *edge.SimulationAPI
	var mobileAdmin *edge.MobileAdminAPI
	var pushSubscriptions *edge.PushSubscriptionsAPI
	var analyticsFees *edge.AnalyticsFeesAPI
	var mutations *edge.MutationsAPI
	var qvapayWebhook *edge.QvapayWebhookAPI
	var liveReader edge.LiveReader
	var paymentPreview *edge.PaymentPreviewAPI
	mobileAuth := &edge.MobileAuthAPI{File: cfg.MobileAuthFile}
	if cfg.AdminPassword != "" && cfg.SessionSecret != "" {
		manager, err := edge.NewSessionManager([]byte(cfg.SessionSecret), 12*time.Hour)
		if err != nil {
			logger.Warn("sesión edge deshabilitada: secreto inválido", "error", err)
		} else {
			session = &edge.SessionHandler{
				Manager: manager, Password: cfg.AdminPassword,
				SecureCookies: cfg.SecureCookies, TTL: 12 * time.Hour,
			}
			operators = &edge.OperatorsAPI{
				Sessions: manager,
				File:     cfg.OperatorsFile,
			}
			operations = &edge.OperationsAPI{
				Sessions: manager,
				File:     cfg.ChatThreadsFile,
			}
			dashboardRead = &edge.DashboardReadAPI{
				Sessions: manager,
				File:     cfg.DashboardFile,
			}
			tradingAnalytics = &edge.TradingAnalyticsAPI{
				Sessions: manager,
				File:     cfg.DashboardFile,
			}
			huntingDiagnostics = &edge.HuntingDiagnosticsAPI{
				Sessions: manager,
				File:     cfg.DashboardFile,
			}
			webExtras = &edge.WebExtrasAPI{
				Sessions: manager, File: cfg.ExtrasFile,
				TrustedOrigin: cfg.TrustedOrigin,
			}
			decisionEvents = &edge.DecisionEventsAPI{
				Sessions: manager, File: cfg.ExtrasFile,
				TrustedOrigin: cfg.TrustedOrigin,
			}
			simulation = &edge.SimulationAPI{
				Sessions: manager, MobileAuth: mobileAuth, File: cfg.ExtrasFile,
				TrustedOrigin: cfg.TrustedOrigin,
			}
			mobileAdmin = &edge.MobileAdminAPI{
				Sessions: manager, MobileAuth: mobileAuth,
				DashboardFile: cfg.DashboardFile, OperatorsFile: cfg.OperatorsFile,
				TrustedOrigin: cfg.TrustedOrigin,
			}
			pushSubscriptions = &edge.PushSubscriptionsAPI{
				Sessions: manager, PublicKey: cfg.PublicPushKey,
				TrustedOrigin: cfg.TrustedOrigin,
			}
			analyticsFees = &edge.AnalyticsFeesAPI{
				Sessions: manager, File: cfg.ExtrasFile,
				TrustedOrigin: cfg.TrustedOrigin,
			}
			mutations = &edge.MutationsAPI{
				Enabled: cfg.MutationsEnabled, Sessions: manager, MobileAuth: mobileAuth,
				TrustedOrigin: cfg.TrustedOrigin,
			}
			qvapayWebhook = &edge.QvapayWebhookAPI{
				Enabled: cfg.WebhookEnabled, Secret: cfg.WebhookSecret,
				ForwardURL: cfg.HunterFeedURL, ForwardToken: cfg.HunterFeedToken,
				ForwardQueue: make(chan []byte, 1024), Logger: logger,
			}
			if writePool != nil {
				webExtras.Acks = &edge.PostgresAckStore{Pool: writePool}
				decisionEvents.Dismissals = &edge.PostgresDismissalStore{Pool: writePool}
				simulation.Runtime = &runtimeconfig.Repository{Pool: writePool}
				mobileStore := &edge.PostgresMobileCredentialStore{Pool: writePool}
				mobileAuth.Overlay = mobileStore
				mobileAdmin.Store = mobileStore
				pushSubscriptions.Store = &edge.PostgresPushStore{Pool: writePool}
				webExtras.Settings = &edge.PostgresReaderStore{Pool: writePool}
				analyticsFees.Store = &edge.PostgresFeeStore{Pool: writePool}
				mutations.Store = &edge.PostgresMutationStore{Pool: writePool}
				mutations.Operations = &localOperationAdapter{
					repo: postgres.NewLocalOperationRepository(writePool),
				}
				mutations.Fiat = &runtimeFiatMover{
					repo: &runtimeconfig.Repository{Pool: writePool},
				}
				qvapayWebhook.Store = &edge.PostgresFeedEventStore{Pool: writePool}
				go qvapayWebhook.RunForwarder(ctx)
			}
			if (cfg.MutationsLive || cfg.LiveDashboard) && cfg.QvaToken != "" && cfg.EncryptionKey != "" {
				vaultClient, err := vault.New(cfg.EncryptionKey)
				if err != nil {
					logger.Warn("QvaPay live deshabilitado: clave inválida", "error", err)
				} else if token, err := vaultClient.Decrypt(cfg.QvaToken); err != nil {
					logger.Warn("QvaPay live deshabilitado: token inválido", "error", err)
				} else {
					if cfg.MutationsLive {
						client := qvapay.NewMutationClient(cfg.MutationBaseURL, token)
						client.Enable()
						mutations.Live = &liveMutations{client: client}
						if writePool != nil {
							if readClient, err := qvapay.New(cfg.MutationBaseURL, token); err == nil {
								configs := &runtimeconfig.Repository{Pool: writePool}
								localOps := postgres.NewLocalOperationRepository(writePool)
								go runOfferRefresh(ctx, logger, readClient, client, configs)
								go runAutoCancel(ctx, logger, readClient, client, configs, localOps)
								logger.Info("bucles de refresco y autocancelación habilitados")
							} else {
								logger.Warn("bucles de mantenimiento deshabilitados", "error", err)
							}
						}
						logger.Info("mutaciones QvaPay LIVE habilitadas")
					}
					if cfg.LiveDashboard {
						if reader, err := qvapay.New(cfg.MutationBaseURL, token); err == nil {
							liveReader = reader
							logger.Info("dashboard QvaPay LIVE habilitado")
						} else {
							logger.Warn("dashboard live deshabilitado", "error", err)
						}
						if chatClient, err := qvapay.NewChatClient(cfg.MutationBaseURL, token); err == nil {
							mutations.Chat = &liveChat{client: chatClient}
							logger.Info("chat QvaPay LIVE habilitado")
						} else {
							logger.Warn("chat live deshabilitado", "error", err)
						}
					}
				}
			}
			if cfg.IconsDir != "" {
				marketIcons = &edge.MarketIconsAPI{
					Sessions: manager, Dir: cfg.IconsDir,
					TrustedOrigin: cfg.TrustedOrigin,
				}
			}
			mobileInsights = &edge.MobileInsightsAPI{
				Auth: mobileAuth,
				File: cfg.DashboardFile,
			}
			configAPI = &edge.ConfigAPI{
				Sessions:      manager,
				PublicPushKey: cfg.PublicPushKey,
			}
			if writePool != nil {
				configAdmin = &edge.ConfigAdminAPI{
					Sessions:      manager,
					Config:        &runtimeconfig.Repository{Pool: writePool},
					Settings:      &edge.PostgresReaderStore{Pool: writePool},
					TrustedOrigin: cfg.TrustedOrigin,
				}
				if cfg.EncryptionKey != "" {
					vaultClient, err := vault.New(cfg.EncryptionKey)
					if err != nil {
						logger.Warn("vault del panel no disponible", "error", err)
					} else {
						marketSource = &edge.MarketSourceAPI{
							Sessions:      manager,
							Store:         &edge.PostgresReaderStore{Pool: writePool},
							Vault:         vaultClient,
							TrustedOrigin: cfg.TrustedOrigin,
						}
					}
				}
			}
			if pool != nil {
				configAPI.Store = &edge.PostgresConfigStore{Pool: pool}
				mobile = &edge.MobileAPI{
					Sessions: manager,
					Store:    &edge.PostgresMobileStore{Pool: pool},
				}
				dashboard = &edge.DashboardAPI{
					Sessions: manager,
					Store:    &edge.PostgresDashboardStore{Pool: pool},
				}
				dashboard.CooperativeFile = cfg.CooperativeFile
				if writePool != nil {
					dashboard.Runtime = &runtimeconfig.Repository{Pool: writePool}
					dashboard.Settings = &edge.PostgresReaderStore{Pool: writePool}
				}
				observability = &edge.ObservabilityAPI{
					Sessions:   manager,
					Store:      &edge.PostgresObservabilityStore{Pool: pool},
					HealthFile: cfg.HealthFile,
				}
				live = &edge.LiveAPI{
					Sessions: manager,
					Store:    &edge.PostgresLiveStore{Pool: pool},
				}
			}
		}
	}
	if dashboard != nil {
		dashboard.Cooperative = cooperativeSync
	}
	if mutations != nil {
		mutations.Cooperative = cooperativeSync
		if writePool != nil {
			mutations.Runtime = &runtimeconfig.Repository{Pool: writePool}
			mutations.Settings = &edge.PostgresReaderStore{Pool: writePool}
		}
	}
	if liveReader != nil && dashboard != nil {
		live := &edge.LiveDashboard{Reader: liveReader, Pool: writePool, Logger: logger}
		if writePool != nil {
			live.Observations = &edge.PostgresMarketObservationStore{Pool: writePool}
		}
		dashboard.Live = live
	}
	if dashboardRead != nil && writePool != nil {
		dashboardRead.Pool = writePool
	}
	if liveReader != nil && mutations != nil {
		mutations.Reconcile = &edge.Reconciler{Reader: liveReader, Store: mutations.Store}
	}
	if liveReader != nil && writePool != nil {
		paymentPreview = &edge.PaymentPreviewAPI{
			MobileAuth: mobileAuth, Reader: liveReader,
			Store: &edge.PostgresPaymentOperationStore{Pool: writePool},
		}
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if session != nil && r.URL.Path == "/api/session" {
			session.ServeHTTP(w, r)
			return
		}
		if qvapayWebhook != nil && r.URL.Path == "/webhooks/qvapay/p2p-feed" {
			qvapayWebhook.ServeHTTP(w, r)
			return
		}
		if paymentPreview != nil && strings.HasPrefix(r.URL.Path, "/api/mobile/operations/") &&
			strings.HasSuffix(r.URL.Path, "/payment-preview") {
			paymentPreview.ServeHTTP(w, r)
			return
		}
		if mutations != nil && mutationPath(r.URL.Path, r.Method) {
			mutations.ServeHTTP(w, r)
			return
		}
		if analyticsFees != nil && r.URL.Path == "/api/analytics/fees" {
			analyticsFees.ServeHTTP(w, r)
			return
		}
		if pushSubscriptions != nil && (r.URL.Path == "/api/push/subscriptions" || r.URL.Path == "/api/push/public-key") {
			pushSubscriptions.ServeHTTP(w, r)
			return
		}
		if mobileAdmin != nil && (r.URL.Path == "/api/mobile/devices" ||
			strings.HasPrefix(r.URL.Path, "/api/mobile/devices/") ||
			r.URL.Path == "/api/mobile/operators" ||
			strings.HasPrefix(r.URL.Path, "/api/mobile/operators/") ||
			r.URL.Path == "/api/mobile/push-device") {
			mobileAdmin.ServeHTTP(w, r)
			return
		}
		if mobileInsights != nil && r.URL.Path == "/api/mobile/insights" {
			mobileInsights.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/mobile/device-check" ||
			r.URL.Path == "/api/mobile/operator-check" ||
			r.URL.Path == "/api/mobile/receipt-outcomes" {
			mobileAuth.ServeHTTP(w, r)
			return
		}
		if dashboardRead != nil && (r.URL.Path == "/api/mobile/devices" ||
			r.URL.Path == "/api/fiat-history" ||
			r.URL.Path == "/api/market-analytics" ||
			r.URL.Path == "/api/analytics/fees" ||
			r.URL.Path == "/api/operations/chats/unread" ||
			r.URL.Path == "/api/mobile/payment-receipts" ||
			strings.HasPrefix(r.URL.Path, "/api/offers/rebalance/")) {
			dashboardRead.ServeHTTP(w, r)
			return
		}
		if tradingAnalytics != nil && r.URL.Path == "/api/trading-analytics" {
			tradingAnalytics.ServeHTTP(w, r)
			return
		}
		if huntingDiagnostics != nil && r.URL.Path == "/api/hunting/diagnostics" {
			huntingDiagnostics.ServeHTTP(w, r)
			return
		}
		if operators != nil && r.URL.Path == "/api/mobile/operators" {
			operators.ServeHTTP(w, r)
			return
		}
		if operations != nil && (r.URL.Path == "/api/operations/chats" || r.URL.Path == "/api/mobile/operations/chats") {
			operations.ServeHTTP(w, r)
			return
		}
		if marketSource != nil && (r.URL.Path == "/api/market-source" ||
			strings.HasPrefix(r.URL.Path, "/api/market-source/") ||
			r.URL.Path == "/api/market-readers" ||
			strings.HasPrefix(r.URL.Path, "/api/market-readers/")) {
			marketSource.ServeHTTP(w, r)
			return
		}
		if configAdmin != nil {
			switch r.URL.Path {
			case "/api/config", "/api/config-revisions", "/api/hunting",
				"/api/strategy", "/api/control":
				configAdmin.ServeHTTP(w, r)
				return
			}
		}
		if marketIcons != nil && r.URL.Path == "/api/market-icons" {
			marketIcons.ServeHTTP(w, r)
			return
		}
		if webExtras != nil && (r.URL.Path == "/api/logs" ||
			r.URL.Path == "/api/notifications" ||
			r.URL.Path == "/api/recovery" ||
			strings.HasPrefix(r.URL.Path, "/api/notifications/") ||
			strings.HasPrefix(r.URL.Path, "/api/recovery/")) {
			webExtras.ServeHTTP(w, r)
			return
		}
		if configAdmin == nil && (r.URL.Path == "/api/config" || r.URL.Path == "/api/config-revisions") {
			writeEdgeUnavailable(w)
			return
		}
		if marketSource == nil && (r.URL.Path == "/api/market-source" ||
			strings.HasPrefix(r.URL.Path, "/api/market-source/") ||
			r.URL.Path == "/api/market-readers" ||
			strings.HasPrefix(r.URL.Path, "/api/market-readers/")) {
			writeEdgeUnavailable(w)
			return
		}
		if configAPI != nil {
			switch r.URL.Path {
			case "/api/audit", "/api/notifications", "/api/logs", "/api/recovery",
				"/api/openapi.json", "/api/push/public-key":
				configAPI.ServeHTTP(w, r)
				return
			}
		}
		if mobile != nil && (r.URL.Path == "/api/mobile" || strings.HasPrefix(r.URL.Path, "/api/mobile/")) {
			mobile.ServeHTTP(w, r)
			return
		}
		if live != nil && (r.URL.Path == "/api/live/transactions" || strings.HasPrefix(r.URL.Path, "/api/live/markets/")) {
			live.ServeHTTP(w, r)
			return
		}
		if dashboard != nil && (r.URL.Path == "/api/dashboard" || strings.HasPrefix(r.URL.Path, "/api/live/")) {
			dashboard.ServeHTTP(w, r)
			return
		}
		if decisionEvents != nil && (r.URL.Path == "/api/decision-events" ||
			strings.HasPrefix(r.URL.Path, "/api/decision-events/") ||
			(strings.HasPrefix(r.URL.Path, "/api/blocked-offers/") && strings.HasSuffix(r.URL.Path, "/dismiss"))) {
			decisionEvents.ServeHTTP(w, r)
			return
		}
		if simulation != nil && (r.URL.Path == "/api/hunting/simulate" || r.URL.Path == "/api/mobile/simulate") {
			simulation.ServeHTTP(w, r)
			return
		}
		if observability != nil && r.URL.Path == "/api/operational-health" {
			observability.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/service-worker.js" ||
			strings.HasPrefix(r.URL.Path, "/auth/") ||
			strings.HasPrefix(r.URL.Path, "/icons/") ||
			strings.HasPrefix(r.URL.Path, "/logo/") ||
			strings.HasPrefix(r.URL.Path, "/market-icons/") {
			staticRoutes.ServeHTTP(w, r)
			return
		}
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

// mutationPath enruta solo las rutas que MutationsAPI reconoce. Evita
// interceptar chats agregados, recuperación de evidencia o descartes, que
// tienen handlers propios.
func mutationPath(path, method string) bool {
	switch {
	case strings.HasPrefix(path, "/api/cooperative-network/"),
		strings.HasPrefix(path, "/api/offers"),
		strings.HasPrefix(path, "/api/workflows/"):
		return true
	case strings.HasPrefix(path, "/api/blocked-offers/"):
		return strings.HasSuffix(path, "/preview") || strings.HasSuffix(path, "/apply")
	case strings.HasPrefix(path, "/api/recovery/"):
		return strings.HasSuffix(path, "/check") || strings.HasSuffix(path, "/resolve")
	case strings.HasPrefix(path, "/api/operations/"):
		return path != "/api/operations/chats" && path != "/api/operations/chats/unread"
	case strings.HasPrefix(path, "/api/mobile/operations/"):
		return path != "/api/mobile/operations/chats"
	case path == "/api/mobile/payment-receipts":
		return method == http.MethodPost
	}
	return false
}

func writeEdgeUnavailable(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte("{\"error\":\"Configuración no disponible.\"}\n"))
}

func loadConfig() (config, error) {
	cfg := config{
		Port:            envOrDefault("PORT", defaultPort),
		StaticDir:       envOrDefault("STATIC_DIR", defaultStatic),
		DatabaseURL:     strings.TrimSpace(os.Getenv("DATABASE_URL")),
		AdminPassword:   strings.TrimSpace(os.Getenv("EDGE_ADMIN_PASSWORD")),
		SessionSecret:   strings.TrimSpace(os.Getenv("EDGE_SESSION_SECRET")),
		TrustedOrigin:   strings.TrimSpace(os.Getenv("EDGE_TRUSTED_ORIGIN")),
		WebhookSecret:   strings.TrimSpace(os.Getenv("EDGE_QVAPAY_WEBHOOK_SECRET")),
		QvaToken:        strings.TrimSpace(os.Getenv("QVA_TOKEN_CIPHERTEXT")),
		MutationBaseURL: envOrDefault("QVAPAY_API_BASE_URL", "https://api.qvapay.com"),
		HunterFeedURL:   envOrDefault("HUNTER_FEED_URL", "http://hunter:8091/feed"),
		HunterFeedToken: strings.TrimSpace(os.Getenv("HUNTER_FEED_TOKEN")),
		SyncBaseURL:     strings.TrimSpace(os.Getenv("SYNC_BASE_URL")),
		SyncNATSUrl:     strings.TrimSpace(os.Getenv("SYNC_NATS_URL")),
		SyncEmail:       strings.TrimSpace(os.Getenv("SYNC_EMAIL")),
		SyncPassword:    strings.TrimSpace(os.Getenv("SYNC_PASSWORD")),
		EncryptionKey:   strings.TrimSpace(os.Getenv("LOCAL_ENCRYPTION_KEY")),
		OperatorsFile:   strings.TrimSpace(os.Getenv("EDGE_OPERATORS_FILE")),
		PublicPushKey:   strings.TrimSpace(os.Getenv("EDGE_PUSH_PUBLIC_KEY")),
		ChatThreadsFile: strings.TrimSpace(os.Getenv("EDGE_CHAT_THREADS_FILE")),
		MobileAuthFile:  strings.TrimSpace(os.Getenv("EDGE_MOBILE_AUTH_FILE")),
		DashboardFile:   strings.TrimSpace(os.Getenv("EDGE_DASHBOARD_SNAPSHOT_FILE")),
		HealthFile:      strings.TrimSpace(os.Getenv("EDGE_OPERATIONAL_HEALTH_FILE")),
		ExtrasFile:      strings.TrimSpace(os.Getenv("EDGE_WEB_EXTRAS_FILE")),
		CooperativeFile: strings.TrimSpace(os.Getenv("EDGE_COOPERATIVE_FILE")),
		IconsDir:        strings.TrimSpace(os.Getenv("EDGE_MARKET_ICONS_DIR")),
	}
	port, err := strconv.Atoi(cfg.Port)
	if err != nil || port < 1 || port > 65535 {
		return config{}, errors.New("PORT inválido")
	}
	for name, target := range map[string]*bool{
		"EDGE_MUTATIONS_ENABLED":      &cfg.MutationsEnabled,
		"EDGE_MUTATIONS_LIVE":         &cfg.MutationsLive,
		"EDGE_LIVE_DASHBOARD":         &cfg.LiveDashboard,
		"EDGE_QVAPAY_WEBHOOK_ENABLED": &cfg.WebhookEnabled,
		"SYNC_ENABLED":                &cfg.SyncEnabled,
	} {
		if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
			value, err := strconv.ParseBool(raw)
			if err != nil {
				return config{}, fmt.Errorf("%s inválido", name)
			}
			*target = value
		}
	}
	if raw := strings.TrimSpace(os.Getenv("EDGE_SECURE_COOKIES")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return config{}, errors.New("EDGE_SECURE_COOKIES inválido")
		}
		cfg.SecureCookies = value
	}
	return cfg, nil
}

// openWritePool abre el pool mínimo usado por las mutaciones de configuración.
// Está separado del pool read-only para que las lecturas sigan sin poder
// escribir aunque un handler tenga un error.
func openWritePool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	poolConfig.MaxConns = 2
	poolConfig.MinConns = 0
	poolConfig.MaxConnLifetime = 30 * time.Minute
	return pgxpool.NewWithConfig(ctx, poolConfig)
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
