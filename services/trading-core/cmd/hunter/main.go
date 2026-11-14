// Servicio de cacerías: polling QvaPay read-only, evaluación y persistencia.
// No muta dinero ni llama a endpoints de escritura de QvaPay.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/hunter"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/vault"
)

const (
	defaultPort     = "8091"
	defaultPollMS   = 3000
	defaultConfig   = "/config/hunter-config.json"
	shutdownTimeout = 10 * time.Second
)

type config struct {
	Port        string
	DatabaseURL string
	BaseURL     string
	PollMS      int
	ConfigFile  string
	Token       string
}

type pollResult struct {
	PolledAt    int64
	LatencyMS   int64
	Offers      int
	Candidates  int
	Error       string
	Evaluations []hunter.Evaluation
}

type source interface {
	Fetch(context.Context) ([]qvapay.Offer, map[string]qvapay.Average, error)
}

type qvapaySource struct {
	client     *qvapay.Client
	mu         sync.Mutex
	averages   map[string]qvapay.Average
	averagesAt time.Time
}

func (source *qvapaySource) Fetch(ctx context.Context) ([]qvapay.Offer, map[string]qvapay.Average, error) {
	offers, err := source.client.Offers(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if len(source.averages) > 0 && time.Since(source.averagesAt) < time.Minute {
		return offers, source.averages, nil
	}
	averages, err := source.client.Averages(ctx)
	if err != nil {
		if len(source.averages) > 0 {
			return offers, source.averages, nil
		}
		return nil, nil, err
	}
	source.averages = averages
	source.averagesAt = time.Now()
	return offers, averages, nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("hunter terminó con error", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	vaultClient, err := vault.New(envOrDefault("LOCAL_ENCRYPTION_KEY", ""))
	if err != nil {
		return err
	}
	token, err := vaultClient.Decrypt(cfg.Token)
	if err != nil {
		return errors.New("no se pudo descifrar el token QvaPay")
	}
	client, err := qvapay.New(cfg.BaseURL, token)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres no responde: %w", err)
	}

	service := &service{
		logger: logger, cfg: cfg, pool: pool, source: &qvapaySource{client: client},
		ready: make(chan struct{}),
	}
	if err := service.loadConfig(); err != nil {
		logger.Warn("configuración hunter no disponible; el servicio seguirá sin mercados", "error", err)
	}

	server := &http.Server{
		Addr: ":" + cfg.Port, Handler: service,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()
	go service.loop(ctx)

	logger.Info("hunter iniciado", "port", cfg.Port, "poll_ms", cfg.PollMS, "config", cfg.ConfigFile)
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
		DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")),
		BaseURL:     envOrDefault("QVAPAY_API_BASE_URL", "https://api.qvapay.com"),
		ConfigFile:  envOrDefault("HUNTER_CONFIG_FILE", defaultConfig),
		Token:       strings.TrimSpace(os.Getenv("QVA_TOKEN_CIPHERTEXT")),
	}
	if cfg.DatabaseURL == "" {
		return config{}, errors.New("falta DATABASE_URL")
	}
	if cfg.Token == "" {
		return config{}, errors.New("falta QVA_TOKEN_CIPHERTEXT")
	}
	if strings.TrimSpace(os.Getenv("LOCAL_ENCRYPTION_KEY")) == "" {
		return config{}, errors.New("falta LOCAL_ENCRYPTION_KEY")
	}
	pollMS, err := strconv.Atoi(envOrDefault("HUNTER_POLL_MS", strconv.Itoa(defaultPollMS)))
	if err != nil || pollMS < 100 || pollMS > 60_000 {
		return config{}, errors.New("HUNTER_POLL_MS debe estar entre 100 y 60000")
	}
	cfg.PollMS = pollMS
	port, err := strconv.Atoi(cfg.Port)
	if err != nil || port < 1 || port > 65535 {
		return config{}, errors.New("PORT inválido")
	}
	return cfg, nil
}

type service struct {
	logger *slog.Logger
	cfg    config
	pool   *pgxpool.Pool
	source source
	ready  chan struct{}

	configMu sync.RWMutex
	config   hunter.Config

	mu          sync.RWMutex
	lastPoll    *pollResult
	polls       atomic.Uint64
	errors      atomic.Uint64
	offers      atomic.Uint64
	candidates  atomic.Uint64
	events      atomic.Uint64
	lastLatency atomic.Int64
	lastPollAt  atomic.Int64
}

func (service *service) loop(ctx context.Context) {
	interval := time.Duration(service.cfg.PollMS) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	service.poll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			service.poll(ctx)
		}
	}
}

func (service *service) loadConfig() error {
	config, err := hunter.LoadConfig(service.cfg.ConfigFile)
	if err != nil {
		return err
	}
	service.configMu.Lock()
	service.config = config
	service.configMu.Unlock()
	return nil
}

func (service *service) currentConfig() hunter.Config {
	service.configMu.RLock()
	defer service.configMu.RUnlock()
	return service.config
}

func (service *service) poll(ctx context.Context) {
	started := time.Now()
	service.polls.Add(1)
	offers, averages, err := service.source.Fetch(ctx)
	latency := time.Since(started).Milliseconds()
	result := &pollResult{PolledAt: time.Now().Unix(), LatencyMS: latency, Offers: len(offers)}
	if err != nil {
		service.errors.Add(1)
		result.Error = err.Error()
		service.logger.Warn("poll QvaPay falló", "error", err)
		service.record(result)
		return
	}
	service.offers.Add(uint64(len(offers)))
	config := service.currentConfig()
	for _, offer := range offers {
		market, ok := config.Markets[offer.Coin]
		if !ok {
			continue
		}
		evaluation := hunter.Evaluate(offer, averages[offer.Coin], market, config.PriceGuardPercent)
		result.Evaluations = append(result.Evaluations, evaluation)
		if evaluation.Decision == "auto_buy" || evaluation.Decision == "manual_sell" {
			result.Candidates++
		}
	}
	service.candidates.Add(uint64(result.Candidates))
	if err := service.persist(ctx, result); err != nil {
		service.errors.Add(1)
		result.Error = err.Error()
		service.logger.Warn("persistir poll hunter falló", "error", err)
	}
	service.record(result)
}

func (service *service) record(result *pollResult) {
	service.lastLatency.Store(result.LatencyMS)
	service.lastPollAt.Store(result.PolledAt)
	service.mu.Lock()
	service.lastPoll = result
	service.mu.Unlock()
	select {
	case <-service.ready:
	default:
		if result.Error == "" {
			close(service.ready)
		}
	}
}

func (service *service) persist(ctx context.Context, result *pollResult) error {
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var pollID int64
	err = tx.QueryRow(ctx, `
		INSERT INTO shadow.hunter_polls (polled_at, latency_ms, offers, candidates, error)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''))
		RETURNING poll_id`,
		result.PolledAt, result.LatencyMS, result.Offers, result.Candidates, result.Error,
	).Scan(&pollID)
	if err != nil {
		return err
	}
	for _, evaluation := range result.Evaluations {
		_, err = tx.Exec(ctx, `
			INSERT INTO shadow.hunter_candidates
				(poll_id, offer_uuid, coin, side, rate, median, decision, reason, observed_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (poll_id, offer_uuid) DO UPDATE SET
				coin = excluded.coin, side = excluded.side, rate = excluded.rate,
				median = excluded.median, decision = excluded.decision, reason = excluded.reason`,
			pollID, evaluation.OfferUUID, evaluation.Coin, evaluation.Side,
			evaluation.Rate.Format(8), evaluation.Median.Format(8),
			evaluation.Decision, evaluation.Reason, result.PolledAt,
		)
		if err != nil {
			return err
		}
		if evaluation.Decision != "auto_buy" && evaluation.Decision != "manual_sell" {
			continue
		}
		payload, err := json.Marshal(evaluation)
		if err != nil {
			return err
		}
		sum := sha256.Sum256([]byte(evaluation.OfferUUID + "|" + evaluation.Decision + "|" + evaluation.Rate.Format(8)))
		eventID := "hunter-" + hex.EncodeToString(sum[:16])
		_, err = tx.Exec(ctx, `
			INSERT INTO shadow.hunter_events
				(event_id, offer_uuid, coin, side, decision, rate, payload_json,
				 state, available_at, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
			ON CONFLICT (event_id) DO NOTHING`,
			eventID, evaluation.OfferUUID, evaluation.Coin, evaluation.Side,
			evaluation.Decision, evaluation.Rate.Format(8), string(payload),
			time.Now().UnixMilli(), result.PolledAt,
		)
		if err != nil {
			return err
		}
		service.events.Add(1)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// Retención local: no dejar crecer la tabla indefinidamente.
	if service.polls.Load()%600 == 0 {
		_, _ = service.pool.Exec(ctx, `DELETE FROM shadow.hunter_polls WHERE polled_at < $1`,
			time.Now().Add(-24*time.Hour).Unix())
	}
	return nil
}

func (service *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/healthz":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case r.Method == http.MethodGet && r.URL.Path == "/readyz":
		service.readyz(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/metrics":
		service.metrics(w)
	case r.Method == http.MethodGet && r.URL.Path == "/candidates":
		service.latest(w)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
	}
}

func (service *service) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := service.pool.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "Postgres"})
		return
	}
	last := service.lastPollAt.Load()
	if last == 0 || time.Now().Unix()-last > int64(3*service.cfg.PollMS/1000+5) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "sin poll reciente"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (service *service) metrics(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprintf(w, "# HELP hunter_polls_total Polls QvaPay ejecutados.\n# TYPE hunter_polls_total counter\nhunter_polls_total %d\n", service.polls.Load())
	fmt.Fprintf(w, "# HELP hunter_errors_total Errores de poll o persistencia.\n# TYPE hunter_errors_total counter\nhunter_errors_total %d\n", service.errors.Load())
	fmt.Fprintf(w, "# HELP hunter_offers_total Ofertas leídas.\n# TYPE hunter_offers_total counter\nhunter_offers_total %d\n", service.offers.Load())
	fmt.Fprintf(w, "# HELP hunter_candidates_total Candidatos auto_buy/manual_sell.\n# TYPE hunter_candidates_total counter\nhunter_candidates_total %d\n", service.candidates.Load())
	fmt.Fprintf(w, "# HELP hunter_events_total Eventos candidate encolados para core.\n# TYPE hunter_events_total counter\nhunter_events_total %d\n", service.events.Load())
	fmt.Fprintf(w, "# HELP hunter_last_latency_ms Latencia del último poll.\n# TYPE hunter_last_latency_ms gauge\nhunter_last_latency_ms %d\n", service.lastLatency.Load())
	fmt.Fprintf(w, "# HELP hunter_last_poll_timestamp_seconds Último poll (Unix).\n# TYPE hunter_last_poll_timestamp_seconds gauge\nhunter_last_poll_timestamp_seconds %d\n", service.lastPollAt.Load())
}

func (service *service) latest(w http.ResponseWriter) {
	service.mu.RLock()
	defer service.mu.RUnlock()
	if service.lastPoll == nil {
		writeJSON(w, http.StatusOK, map[string]any{"evaluations": []any{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"polledAt": service.lastPoll.PolledAt, "latencyMs": service.lastPoll.LatencyMS,
		"offers": service.lastPoll.Offers, "candidates": service.lastPoll.Candidates,
		"error": service.lastPoll.Error, "evaluations": service.lastPoll.Evaluations,
	})
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
