// Servicio edge: estáticos, sesión y resumen de sólo lectura para web/Android.
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
	Port            string
	StaticDir       string
	DatabaseURL     string
	AdminPassword   string
	SessionSecret   string
	SecureCookies   bool
	OperatorsFile   string
	PublicPushKey   string
	ChatThreadsFile string
	MobileAuthFile  string
	DashboardFile   string
	TrustedOrigin   string
	EncryptionKey   string
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
				if writePool != nil {
					dashboard.Runtime = &runtimeconfig.Repository{Pool: writePool}
					dashboard.Settings = &edge.PostgresReaderStore{Pool: writePool}
				}
				observability = &edge.ObservabilityAPI{
					Sessions: manager,
					Store:    &edge.PostgresObservabilityStore{Pool: pool},
				}
				live = &edge.LiveAPI{
					Sessions: manager,
					Store:    &edge.PostgresLiveStore{Pool: pool},
				}
			}
		}
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if session != nil && r.URL.Path == "/api/session" {
			session.ServeHTTP(w, r)
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
		if observability != nil && (r.URL.Path == "/api/decision-events" || r.URL.Path == "/api/operational-health") {
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
		EncryptionKey:   strings.TrimSpace(os.Getenv("LOCAL_ENCRYPTION_KEY")),
		OperatorsFile:   strings.TrimSpace(os.Getenv("EDGE_OPERATORS_FILE")),
		PublicPushKey:   strings.TrimSpace(os.Getenv("EDGE_PUSH_PUBLIC_KEY")),
		ChatThreadsFile: strings.TrimSpace(os.Getenv("EDGE_CHAT_THREADS_FILE")),
		MobileAuthFile:  strings.TrimSpace(os.Getenv("EDGE_MOBILE_AUTH_FILE")),
		DashboardFile:   strings.TrimSpace(os.Getenv("EDGE_DASHBOARD_SNAPSHOT_FILE")),
	}
	port, err := strconv.Atoi(cfg.Port)
	if err != nil || port < 1 || port > 65535 {
		return config{}, errors.New("PORT inválido")
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
