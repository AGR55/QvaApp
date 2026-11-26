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
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/hunting"
	"github.com/AGR55/QvaApp/services/trading-core/internal/hunter"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/vault"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const (
	defaultPort     = "8091"
	defaultPollMS   = 0
	defaultConfig   = "/config/hunter-config.json"
	defaultSpoolDir = "/var/lib/hunter-spool"
	shutdownTimeout = 10 * time.Second

	// pollTickInterval es la resolución del planificador. El intervalo real
	// de poll lo fija la configuración runtime y puede ser mayor.
	pollTickInterval = 500 * time.Millisecond
	// pollTimeout acota cada ciclo completo: ofertas y promedios.
	pollTimeout = 30 * time.Second
)

type config struct {
	Port        string
	DatabaseURL string
	BaseURL     string
	PollMS      int
	ConfigFile  string
	Token       string
	AppID       string
	AppSecret   string
	FeedToken   string
	SpoolDir    string
}

type pollResult struct {
	SpoolID     string `json:"-"`
	PolledAt    int64
	LatencyMS   int64
	Offers      int
	Candidates  int
	Source      string
	Error       string
	Evaluations []hunter.Evaluation
}

type source interface {
	Fetch(context.Context) ([]qvapay.Offer, map[string]qvapay.Average, error)
	Averages(context.Context) (map[string]qvapay.Average, error)
}

// offerTarget identifica una consulta de listado válida para best_rate: QvaPay
// exige lado y moneda explícitos al ordenar por tasa.
type offerTarget struct {
	Coin string
	Side string
}

type qvapaySource struct {
	client           *qvapay.Client
	readers          func(context.Context) []*qvapay.Client
	targets          func() []offerTarget
	index            atomic.Uint64
	targetIndex      atomic.Uint64
	mu               sync.Mutex
	averages         map[string]qvapay.Average
	averagesAt       time.Time
	refreshing       bool
	ownUUID          string
	eligibilityMu    sync.Mutex
	eligibilityState *hunting.State
}

func (source *qvapaySource) Fetch(ctx context.Context) ([]qvapay.Offer, map[string]qvapay.Average, error) {
	// Una sola lectura de listado por ciclo (~25/min) rota entre mercados y
	// lados para poder ordenar por best_rate sin superar la cuota de QvaPay.
	target := source.nextTarget()
	params := url.Values{
		"take": {"100"}, "page": {"1"}, "type": {target.Side}, "status": {"open"},
	}
	if target.Coin != "" {
		params.Set("coin", target.Coin)
		params.Set("orderBy", "best_rate")
		params.Set("orderType", "desc")
	}
	offers, err := source.nextClient(ctx).Offers(ctx, params)
	if err != nil {
		return nil, nil, err
	}
	offers = source.withoutOwnOffers(ctx, offers)
	averages, err := source.Averages(ctx)
	if err != nil {
		return nil, nil, err
	}
	return offers, averages, nil
}

func (source *qvapaySource) nextTarget() offerTarget {
	if source.targets != nil {
		targets := source.targets()
		if len(targets) > 0 {
			index := source.targetIndex.Add(1) - 1
			return targets[index%uint64(len(targets))]
		}
	}
	// Sin configuración de mercados se mantiene una lectura global válida.
	return offerTarget{Side: "sell"}
}

// withoutOwnOffers excluye las ofertas creadas por la propia cuenta. Si no se
// puede resolver la identidad se devuelven todas: QvaPay rechazaría la
// auto-aplicación, pero no se debe bloquear la caza por un fallo de lectura.
func (source *qvapaySource) withoutOwnOffers(ctx context.Context, offers []qvapay.Offer) []qvapay.Offer {
	own := source.ownIdentity(ctx)
	for _, offer := range offers {
		source.recordOfferProfiles(offer, own, time.Now())
	}
	if own == "" {
		return offers
	}
	filtered := make([]qvapay.Offer, 0, len(offers))
	for _, offer := range offers {
		if offer.UUID == "" || offerHasIdentity(offer, own) {
			continue
		}
		filtered = append(filtered, offer)
	}
	return filtered
}

func (source *qvapaySource) ownIdentity(ctx context.Context) string {
	source.mu.Lock()
	if source.ownUUID != "" {
		uuid := source.ownUUID
		source.mu.Unlock()
		return uuid
	}
	source.mu.Unlock()
	user, err := source.client.User(ctx)
	if err != nil {
		return ""
	}
	source.mu.Lock()
	source.ownUUID = strings.TrimSpace(user.UUID)
	uuid := source.ownUUID
	source.mu.Unlock()
	source.recordProfile(user.Profile, time.Now())
	return uuid
}

func (source *qvapaySource) recordProfile(fields map[string]any, now time.Time) {
	if len(fields) == 0 {
		return
	}
	eligibility := profileEligibility(fields, now)
	source.eligibilityMu.Lock()
	defer source.eligibilityMu.Unlock()
	if source.eligibilityState == nil {
		source.eligibilityState = hunting.NewState()
	}
	source.eligibilityState.RecordEligibility(eligibility, decimal.FromInt(now.UnixMilli()))
}

func profileEligibility(fields map[string]any, now time.Time) hunting.Eligibility {
	var result hunting.Eligibility
	count, _ := fields["_count"].(map[string]any)
	p2p, p2pOK := profileNumber(count["P2P"])
	peer, peerOK := profileNumber(count["P2P_Peer"])
	if p2pOK && peerOK {
		completed := p2p.Add(peer)
		result.Completed = &completed
	}
	if value, ok := profileNumber(firstProfileValue(fields["rating_avg"], fields["average_rating"])); ok {
		result.Rating = &value
	}
	if value, ok := profileNumber(firstProfileValue(fields["trustscore"], fields["trust_score"])); ok {
		result.TrustScore = &value
	}
	if raw, ok := fields["created_at"].(string); ok {
		created, err := time.Parse(time.RFC3339Nano, raw)
		if err == nil && !created.After(now) {
			days := decimal.FromInt(int64(now.Sub(created) / (24 * time.Hour)))
			result.AccountDays = &days
		}
	}
	switch kyc := fields["kyc"].(type) {
	case bool:
		value := decimal.Zero()
		if kyc {
			value = decimal.FromInt(1)
		}
		result.Kyc = &value
	case string:
		if kyc == "verified" {
			value := decimal.FromInt(1)
			result.Kyc = &value
		}
	}
	return result
}

func firstProfileValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func profileNumber(value any) (decimal.Value, bool) {
	if value == nil {
		return decimal.Zero(), false
	}
	var text string
	switch typed := value.(type) {
	case json.Number:
		text = typed.String()
	case string:
		text = strings.TrimSpace(typed)
	case float64:
		text = strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return decimal.Zero(), false
	}
	parsed, err := decimal.Parse(text)
	return parsed, err == nil && parsed.Sign() >= 0
}

func profileUUID(raw json.RawMessage) string {
	var profile map[string]any
	if json.Unmarshal(raw, &profile) != nil {
		return ""
	}
	uuid, _ := profile["uuid"].(string)
	return strings.TrimSpace(uuid)
}

func (source *qvapaySource) recordOfferProfiles(offer qvapay.Offer, owner string, now time.Time) {
	if owner == "" {
		return
	}
	for _, raw := range []json.RawMessage{offer.User, offer.Peer} {
		if profileUUID(raw) != owner {
			continue
		}
		var profile map[string]any
		if json.Unmarshal(raw, &profile) == nil {
			source.recordProfile(profile, now)
		}
	}
}

func (source *qvapaySource) huntingRequirementReason(offer qvapay.Offer, now time.Time) (string, bool) {
	if source == nil {
		return "", false
	}
	source.eligibilityMu.Lock()
	defer source.eligibilityMu.Unlock()
	if source.eligibilityState == nil {
		return "", false
	}
	return source.eligibilityState.Reason(hunting.Offer{
		RequirementsMet: offer.RequirementsMet,
		HasRequirements: len(offer.Requirements) > 0,
		Requirements:    offer.Requirements,
		OnlyKyc:         offer.OnlyKYC,
	}, decimal.FromInt(now.UnixMilli()))
}

func offerHasIdentity(offer qvapay.Offer, uuid string) bool {
	if uuid == "" {
		return false
	}
	if strings.TrimSpace(offer.OwnerUUID) == uuid {
		return true
	}
	for _, party := range []json.RawMessage{offer.User, offer.Peer} {
		if profileUUID(party) == uuid {
			return true
		}
	}
	return false
}

func (source *qvapaySource) Averages(ctx context.Context) (map[string]qvapay.Average, error) {
	source.mu.Lock()
	age := time.Since(source.averagesAt)
	if len(source.averages) > 0 && age < 5*time.Minute {
		averages := source.averages
		if !source.refreshing && age > 4*time.Minute {
			source.refreshing = true
			go source.refreshAverages()
		}
		source.mu.Unlock()
		return averages, nil
	}
	if len(source.averages) > 0 {
		if source.refreshing {
			source.mu.Unlock()
			return nil, errors.New("promedios vencidos; actualización en curso")
		}
		source.refreshing = true
		source.mu.Unlock()
		return source.fetchFreshAverages(ctx)
	}
	if source.refreshing {
		source.mu.Unlock()
		return nil, errors.New("promedios aún no disponibles; actualización en curso")
	}
	source.refreshing = true
	source.mu.Unlock()
	return source.fetchFreshAverages(ctx)
}

func (source *qvapaySource) fetchFreshAverages(ctx context.Context) (map[string]qvapay.Average, error) {
	averages, err := source.nextClient(ctx).Averages(ctx)
	source.mu.Lock()
	defer source.mu.Unlock()
	source.refreshing = false
	if err != nil {
		return nil, err
	}
	source.averages = averages
	source.averagesAt = time.Now()
	return averages, nil
}

func (source *qvapaySource) refreshAverages() {
	ctx, cancel := context.WithTimeout(context.Background(), pollTimeout)
	defer cancel()
	averages, err := source.nextClient(ctx).Averages(ctx)
	source.mu.Lock()
	defer source.mu.Unlock()
	source.refreshing = false
	if err == nil {
		source.averages = averages
		source.averagesAt = time.Now()
	}
}

// nextClient rota entre las cuentas lectoras habilitadas. Cada llamada avanza
// el índice, de modo que un token rechazado deja de usarse en el siguiente
// poll. Sin lectores se usa el cliente primario.
func (source *qvapaySource) nextClient(ctx context.Context) *qvapay.Client {
	if source.readers == nil {
		return source.client
	}
	clients := source.readers(ctx)
	if selected := selectReaderClient(clients, source.index.Add(1)-1); selected != nil {
		return selected
	}
	return source.client
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
	// El hunter puede arrancar sin Postgres para reproducir el spool local y
	// seguir reteniendo eventos SSE durante una interrupción de la base.
	if err := pool.Ping(ctx); err != nil {
		logger.Warn("postgres no responde al inicio; hunter conserva eventos en spool y reintentará persistir", "error", err)
	}

	service := &service{
		logger: logger, cfg: cfg, runCtx: ctx, pool: pool,
		vault: vaultClient, baseURL: cfg.BaseURL,
		runtime:     &runtimeconfig.Repository{Pool: pool},
		ready:       make(chan struct{}),
		streamQueue: make(chan *pollResult, 4096),
	}
	service.spool, err = openDurableSpool(cfg.SpoolDir)
	if err != nil {
		return err
	}
	service.exclusions = postgres.NewOfferExclusionRepository(pool)
	service.refreshExclusions(ctx)
	go service.exclusionLoop(ctx)
	// Sin configuración runtime el planificador conserva el intervalo de la
	// variable de entorno.
	service.pollInterval.Store(int64(cfg.PollMS))
	service.source = &qvapaySource{
		client: client, readers: service.readerClients, targets: service.offerTargets,
	}
	if err := service.loadConfig(); err != nil {
		logger.Warn("configuración hunter no disponible; el servicio seguirá sin mercados", "error", err)
	}
	// La configuración del panel tiene prioridad sobre el archivo. Si todavía
	// no existe, se mantiene la leída del archivo.
	reloadCtx, cancelReload := context.WithTimeout(ctx, runtimeReloadTimeout)
	service.reloadRuntimeConfig(reloadCtx)
	cancelReload()
	server := &http.Server{
		Addr: ":" + cfg.Port, Handler: service,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()
	go service.loop(ctx)
	go service.runtimeLoop(ctx)
	go service.batchLoop(ctx)
	go service.replaySpool(ctx)
	service.startStream(ctx, logger)

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
		AppID:       strings.TrimSpace(os.Getenv("QVA_APP_ID_CIPHERTEXT")),
		AppSecret:   strings.TrimSpace(os.Getenv("QVA_APP_SECRET_CIPHERTEXT")),
		FeedToken:   strings.TrimSpace(os.Getenv("HUNTER_FEED_TOKEN")),
		SpoolDir:    envOrDefault("HUNTER_SPOOL_DIR", defaultSpoolDir),
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
	if err != nil || pollMS < 0 || pollMS > 60_000 || (pollMS > 0 && pollMS < 1000) {
		return config{}, errors.New("HUNTER_POLL_MS debe ser 0 (SSE-only) o estar entre 1000 y 60000")
	}
	if pollMS > 0 && pollMS < 2400 {
		pollMS = 2400 // no superar 25 lecturas de listado por minuto.
	}
	cfg.PollMS = pollMS
	port, err := strconv.Atoi(cfg.Port)
	if err != nil || port < 1 || port > 65535 {
		return config{}, errors.New("PORT inválido")
	}
	return cfg, nil
}

type service struct {
	logger    *slog.Logger
	cfg       config
	runCtx    context.Context
	pool      *pgxpool.Pool
	source    source
	vault     *vault.Vault
	baseURL   string
	runtime   *runtimeconfig.Repository
	ready     chan struct{}
	readyOnce sync.Once
	spool     *durableSpool

	exclusions   *postgres.OfferExclusionRepository
	excludedMu   sync.RWMutex
	excluded     map[string]struct{}
	excludedSeen int64

	// pollInterval y paused los refresca runtimeLoop cada 5 s. El intervalo
	// está en milisegundos; 0 significa sin poll (solo SSE).
	pollInterval  atomic.Int64
	paused        atomic.Bool
	configVersion atomic.Int64
	// lastPollAttemptMS marca el intento de poll para el planificador, en
	// milisegundos. lastPollAt sigue en segundos para métricas y readyz.
	lastPollAttemptMS atomic.Int64

	configMu      sync.RWMutex
	config        hunter.Config
	runtimeConfig runtimeconfig.Config
	runtimeLoaded bool

	readersMu   sync.Mutex
	readerCache []*qvapay.Client
	readersAt   time.Time

	mu          sync.RWMutex
	lastPoll    *pollResult
	polls       atomic.Uint64
	errors      atomic.Uint64
	offers      atomic.Uint64
	candidates  atomic.Uint64
	events      atomic.Uint64
	lastLatency atomic.Int64
	lastPollAt  atomic.Int64

	streamConnected    atomic.Bool
	streamRaw          atomic.Uint64
	streamEvents       atomic.Uint64
	streamIgnored      atomic.Uint64
	streamErrors       atomic.Uint64
	streamConsecutive  atomic.Uint64
	streamLastAt       atomic.Int64
	streamLastLagMS    atomic.Int64
	streamLastDecision atomic.Int64
	streamLastEnqueue  atomic.Int64
	streamQueue        chan *pollResult
	persistBatches     atomic.Uint64
}

func (service *service) startStream(ctx context.Context, logger *slog.Logger) {
	if service.cfg.AppID == "" || service.cfg.AppSecret == "" {
		logger.Info("feed SSE deshabilitado: faltan credenciales de app")
		return
	}
	vaultClient, err := vault.New(envOrDefault("LOCAL_ENCRYPTION_KEY", ""))
	if err != nil {
		logger.Warn("feed SSE deshabilitado: clave de cifrado inválida", "error", err)
		return
	}
	appID, err := vaultClient.Decrypt(service.cfg.AppID)
	if err != nil {
		logger.Warn("feed SSE deshabilitado: app-id no descifrable")
		return
	}
	appSecret, err := vaultClient.Decrypt(service.cfg.AppSecret)
	if err != nil {
		logger.Warn("feed SSE deshabilitado: app-secret no descifrable")
		return
	}
	stream := qvapay.NewStream()
	// Con SSE-only no hay poll que llene la caché de medianas: se carga una
	// vez y se refresca cada 5 min.
	go func() {
		seedCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if _, err := service.source.Averages(seedCtx); err != nil {
			logger.Warn("promedios QvaPay iniciales no disponibles", "error", err)
		}
	}()
	go func() {
		err := stream.Run(ctx, qvapay.StreamCredentials{AppID: appID, AppSecret: appSecret}, service.handleStreamEvent, service.handleStreamState)
		if err != nil && ctx.Err() == nil {
			logger.Warn("feed SSE terminó", "error", err)
		}
	}()
}

func (service *service) handleStreamState(state qvapay.StreamState) {
	service.streamConnected.Store(state.Connected)
	if state.Connected {
		service.streamConsecutive.Store(0)
	}
	if state.Error != "" {
		service.streamErrors.Add(1)
		service.streamConsecutive.Add(1)
		service.logger.Warn("estado feed SSE", "phase", state.Phase, "error", state.Error)
	}
}

func (service *service) refreshExclusions(ctx context.Context) {
	if service == nil || service.exclusions == nil {
		return
	}
	offers, err := service.exclusions.ExcludedOffers(ctx)
	if err != nil {
		if service.logger != nil {
			service.logger.Warn("no se pudieron refrescar las ofertas excluidas", "error", err)
		}
		return
	}
	excluded := make(map[string]struct{}, len(offers))
	for _, uuid := range offers {
		excluded[uuid] = struct{}{}
	}
	service.excludedMu.Lock()
	service.excluded = excluded
	service.excludedSeen = int64(len(excluded))
	service.excludedMu.Unlock()
}

func (service *service) exclusionLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			service.refreshExclusions(ctx)
		}
	}
}

func (service *service) isOfferExcluded(uuid string) bool {
	if service == nil || strings.TrimSpace(uuid) == "" {
		return false
	}
	service.excludedMu.RLock()
	defer service.excludedMu.RUnlock()
	_, ok := service.excluded[strings.TrimSpace(uuid)]
	return ok
}

func (service *service) excludedCount() int64 {
	service.excludedMu.RLock()
	defer service.excludedMu.RUnlock()
	return service.excludedSeen
}

func (service *service) handleStreamEvent(event qvapay.StreamEvent) {
	service.streamRaw.Add(1)
	switch event.Event {
	case "init":
		// Handshake del stream: no es una oferta ni un error.
		return
	case "subscription_expired":
		service.streamErrors.Add(1)
		service.logger.Error("suscripción del feed P2P vencida", "detail", string(event.Data))
		return
	}
	var payload struct {
		Data   json.RawMessage `json:"data"`
		SentAt string          `json:"sent_at"`
	}
	if err := json.Unmarshal(event.Data, &payload); err != nil || len(payload.Data) == 0 {
		service.streamErrors.Add(1)
		service.logger.Warn("evento SSE sin data válida", "event", event.Event)
		return
	}
	var offer qvapay.Offer
	if err := json.Unmarshal(payload.Data, &offer); err != nil {
		service.streamErrors.Add(1)
		service.logger.Warn("oferta SSE inválida", "event", event.Event, "error", err)
		return
	}
	service.handleOffer(event.Event, offer, payload.SentAt, "stream")
}

// handleOffer es el camino común de SSE y webhook: evalúa y encola el evento
// sin bloquear el lector con la base de datos.
func (service *service) handleOffer(eventName string, offer qvapay.Offer, sentAt, source string) {
	if service.paused.Load() {
		return
	}
	if service.isOfferExcluded(offer.UUID) {
		service.streamIgnored.Add(1)
		return
	}
	service.offers.Add(1)
	switch eventName {
	case "p2p.created", "p2p.reopened", "p2p.resumed", "p2p.range_created", "p2p.range_updated":
	default:
		// Salidas y cambios de operaciones ya en curso: no crean una
		// oportunidad. El apply vuelve a leer la oferta antes de mutar.
		service.streamIgnored.Add(1)
		return
	}
	service.streamEvents.Add(1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if source, ok := service.source.(*qvapaySource); ok {
		owner := source.ownIdentity(ctx)
		source.recordOfferProfiles(offer, owner, time.Now())
		if owner != "" && offerHasIdentity(offer, owner) {
			return
		}
	}
	averages, err := service.source.Averages(ctx)
	if err != nil {
		service.streamErrors.Add(1)
		service.logger.Warn("promedios SSE no disponibles", "error", err)
		return
	}
	config := service.currentConfig()
	market, ok := config.Markets[offer.Coin]
	if !ok {
		return
	}
	decisionStarted := time.Now()
	decision := hunter.Evaluate(offer, averages[offer.Coin], market, config.PriceGuardPercent)
	service.applyHuntingRequirements(&decision, offer, time.Now())
	decisionElapsed := time.Since(decisionStarted)
	lag := int64(0)
	if parsed, err := time.Parse(time.RFC3339Nano, sentAt); err == nil {
		lag = maxInt64(0, time.Since(parsed).Milliseconds())
		decision.ObservedAt = parsed.UnixMilli()
	}
	result := &pollResult{
		PolledAt: time.Now().Unix(), LatencyMS: lag, Offers: 1, Source: source,
		Evaluations: []hunter.Evaluation{decision},
	}
	if decision.Decision == "auto_buy" || decision.Decision == "manual_sell" {
		result.Candidates = 1
	}
	enqueueStarted := time.Now()
	service.enqueue(result)
	service.streamLastAt.Store(result.PolledAt)
	service.streamLastLagMS.Store(lag)
	service.streamLastDecision.Store(decisionElapsed.Microseconds())
	service.streamLastEnqueue.Store(time.Since(enqueueStarted).Microseconds())
	service.candidates.Add(uint64(result.Candidates))
	service.record(result)
}

func (service *service) applyHuntingRequirements(evaluation *hunter.Evaluation, offer qvapay.Offer, now time.Time) {
	if evaluation == nil {
		return
	}
	source, ok := service.source.(*qvapaySource)
	if !ok {
		return
	}
	if reason, blocked := source.huntingRequirementReason(offer, now); blocked {
		evaluation.Decision = "ignored"
		evaluation.Reason = reason
	}
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func (service *service) loop(ctx context.Context) {
	ticker := time.NewTicker(pollTickInterval)
	defer ticker.Stop()
	var inFlight atomic.Bool
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if service.paused.Load() {
				continue
			}
			intervalMS := service.pollInterval.Load()
			if intervalMS <= 0 {
				continue
			}
			now := time.Now().UnixMilli()
			if now-service.lastPollAttemptMS.Load() < intervalMS {
				continue
			}
			// Un poll lento no acumula ejecuciones: los ticks que caen
			// mientras hay uno en curso se descartan.
			if !inFlight.CompareAndSwap(false, true) {
				continue
			}
			service.lastPollAttemptMS.Store(now)
			go func() {
				defer inFlight.Store(false)
				pollCtx, cancel := context.WithTimeout(ctx, pollTimeout)
				defer cancel()
				service.poll(pollCtx)
			}()
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

// offerTargets enumera los pares mercado/lado que la cacería necesita. El
// orden es estable para repartir la cuota entre todos ellos de forma justa.
func (service *service) offerTargets() []offerTarget {
	config := service.currentConfig()
	codes := make([]string, 0, len(config.Markets))
	for code := range config.Markets {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	targets := make([]offerTarget, 0, 2*len(codes))
	for _, code := range codes {
		if market := config.Markets[code]; market.Active && market.HuntBuy {
			targets = append(targets, offerTarget{Coin: code, Side: "sell"})
		}
	}
	for _, code := range codes {
		if market := config.Markets[code]; market.Active && market.HuntSell {
			targets = append(targets, offerTarget{Coin: code, Side: "buy"})
		}
	}
	return targets
}

func (service *service) poll(ctx context.Context) {
	started := time.Now()
	service.polls.Add(1)
	offers, averages, err := service.source.Fetch(ctx)
	latency := time.Since(started).Milliseconds()
	result := &pollResult{PolledAt: time.Now().Unix(), LatencyMS: latency, Offers: len(offers), Source: "poll"}
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
		if service.isOfferExcluded(offer.UUID) {
			continue
		}
		market, ok := config.Markets[offer.Coin]
		if !ok {
			continue
		}
		evaluation := hunter.Evaluate(offer, averages[offer.Coin], market, config.PriceGuardPercent)
		service.applyHuntingRequirements(&evaluation, offer, time.Now())
		// En polling la cotización se acaba de leer: la antigüedad relevante es
		// desde esta observación, no el updated_at histórico de la oferta.
		evaluation.ObservedAt = time.Now().UnixMilli()
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
	if result.Error == "" && service.ready != nil {
		service.readyOnce.Do(func() { close(service.ready) })
	}
}

func (service *service) enqueue(result *pollResult) {
	if service.spool != nil {
		if err := service.spool.Append(result); err != nil {
			service.streamErrors.Add(1)
			service.logger.Error("no se pudo asegurar el evento SSE en spool; se descarta antes de operar", "error", err)
			return
		}
	}
	select {
	case service.streamQueue <- result:
	default:
		// La cola está llena: se persiste en línea para no perder un candidato.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := service.persist(ctx, result); err != nil {
			service.streamErrors.Add(1)
			service.logger.Warn("persistir evento SSE falló", "error", err)
			if service.runCtx != nil {
				select {
				case service.streamQueue <- result:
					service.logger.Warn("evento SSE retenido en cola tras fallar persistencia directa")
				case <-service.runCtx.Done():
					service.logger.Warn("evento SSE no pudo conservarse durante el apagado")
				}
			}
		} else if service.spool != nil {
			if err := service.spool.Acknowledge([]*pollResult{result}); err != nil {
				service.logger.Error("evento SSE guardado en Postgres pero no se pudo compactar el spool", "error", err)
			}
		}
	}
}

// batchLoop agrupa eventos SSE y los persiste en una sola transacción. El
// lector SSE nunca espera por la base: solo evalúa y encola.
func (service *service) batchLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	batch := make([]*pollResult, 0, 256)
	retryAfter := time.Time{}
	retryDelay := time.Second
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		if !retryAfter.IsZero() && time.Now().Before(retryAfter) {
			return false
		}
		flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := service.persistBatch(flushCtx, batch)
		cancel()
		if err != nil {
			service.streamErrors.Add(1)
			service.logger.Warn("persistir lote SSE falló", "eventos", len(batch), "error", err)
			retryAfter = time.Now().Add(retryDelay)
			retryDelay *= 2
			if retryDelay > 30*time.Second {
				retryDelay = 30 * time.Second
			}
			return false
		}
		if service.spool != nil {
			if err := service.spool.Acknowledge(batch); err != nil {
				service.logger.Error("lote SSE guardado pero no se pudo compactar el spool", "error", err)
			}
		}
		batch = batch[:0]
		retryAfter = time.Time{}
		retryDelay = time.Second
		return true
	}
	for {
		queue := (<-chan *pollResult)(service.streamQueue)
		if len(batch) >= 256 {
			queue = nil // conserva el lote fallido y deja que la cola acotada aplique backpressure.
		}
		select {
		case <-ctx.Done():
			retryAfter = time.Time{}
			if !flush() && len(batch) > 0 {
				service.logger.Error("eventos SSE pendientes al cerrar hunter con Postgres no disponible", "eventos", len(batch))
			}
			return
		case result := <-queue:
			batch = append(batch, result)
			if len(batch) >= 256 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (service *service) replaySpool(ctx context.Context) {
	if service.spool == nil {
		return
	}
	for _, result := range service.spool.Pending() {
		select {
		case service.streamQueue <- result:
		case <-ctx.Done():
			return
		}
	}
}

func (service *service) persist(ctx context.Context, result *pollResult) error {
	return service.persistBatch(ctx, []*pollResult{result})
}

func (service *service) persistBatch(ctx context.Context, results []*pollResult) error {
	if len(results) == 0 {
		return nil
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	polledAt := time.Now().Unix()
	offers, candidates, latency := 0, 0, int64(0)
	source := "stream-batch"
	errorText := ""
	for _, result := range results {
		offers += result.Offers
		candidates += result.Candidates
		if result.LatencyMS > latency {
			latency = result.LatencyMS
		}
		if result.Error != "" && errorText == "" {
			errorText = result.Error
		}
	}
	if len(results) == 1 {
		source = results[0].Source
		polledAt = results[0].PolledAt
	}
	var pollID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO shadow.hunter_polls (polled_at, latency_ms, offers, candidates, source, error)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))
		RETURNING poll_id`,
		polledAt, latency, offers, candidates, source, errorText,
	).Scan(&pollID); err != nil {
		return err
	}

	batch := &pgx.Batch{}
	eventQueryIndexes := make(map[int]struct{})
	for _, result := range results {
		for _, evaluation := range result.Evaluations {
			if evaluation.Decision == "ignored" {
				continue
			}
			evaluation.Source = result.Source
			batch.Queue(`
				INSERT INTO shadow.hunter_candidates
					(poll_id, offer_uuid, coin, side, rate, median, decision, reason, observed_at, source)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				ON CONFLICT (poll_id, offer_uuid) DO UPDATE SET
					coin = excluded.coin, side = excluded.side, rate = excluded.rate,
					median = excluded.median, decision = excluded.decision, reason = excluded.reason`,
				pollID, evaluation.OfferUUID, evaluation.Coin, evaluation.Side,
				evaluation.Rate.Format(8), evaluation.Median.Format(8),
				evaluation.Decision, evaluation.Reason, result.PolledAt, result.Source,
			)
			if evaluation.Decision != "auto_buy" && evaluation.Decision != "manual_sell" {
				continue
			}
			payload, err := json.Marshal(evaluation)
			if err != nil {
				return err
			}
			fingerprint := strings.Join([]string{
				evaluation.OfferUUID, evaluation.Decision, evaluation.Rate.Format(8),
				evaluation.Amount.Format(8), evaluation.Receive.Format(8),
				evaluation.Available.Format(8), evaluation.OrderMin.Format(8), evaluation.OrderMax.Format(8),
				strconv.FormatInt(result.PolledAt/60, 10), // reevalúa cada minuto sin duplicar cada poll.
			}, "|")
			sum := sha256.Sum256([]byte(fingerprint))
			eventID := "hunter-" + hex.EncodeToString(sum[:16])
			eventQueryIndexes[batch.Len()] = struct{}{}
			batch.Queue(`
				INSERT INTO shadow.hunter_events
					(event_id, offer_uuid, coin, side, decision, rate, payload_json,
					 state, available_at, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
				ON CONFLICT (event_id) DO UPDATE
				SET payload_json = EXCLUDED.payload_json
				WHERE shadow.hunter_events.state = 'pending'
				  AND shadow.hunter_events.payload_json::jsonb->>'source' = 'poll'
				  AND EXCLUDED.payload_json::jsonb->>'source' IN ('stream', 'webhook')`,
				eventID, evaluation.OfferUUID, evaluation.Coin, evaluation.Side,
				evaluation.Decision, evaluation.Rate.Format(8), string(payload),
				time.Now().UnixMilli(), result.PolledAt,
			)
		}
	}
	var eventsInserted uint64
	if batch.Len() > 0 {
		br := tx.SendBatch(ctx, batch)
		for index := 0; index < batch.Len(); index++ {
			tag, err := br.Exec()
			if err != nil {
				_ = br.Close()
				return err
			}
			if _, isEventInsert := eventQueryIndexes[index]; isEventInsert && tag.RowsAffected() > 0 {
				eventsInserted++
			}
		}
		if err := br.Close(); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, "NOTIFY hunter_events"); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	service.events.Add(eventsInserted)
	service.persistBatches.Add(1)
	if service.persistBatches.Load()%600 == 0 {
		cutoff := time.Now().Add(-24 * time.Hour).Unix()
		_, _ = service.pool.Exec(ctx, `DELETE FROM shadow.hunter_candidates WHERE observed_at < $1`, cutoff)
		_, _ = service.pool.Exec(ctx, `DELETE FROM shadow.hunter_polls WHERE polled_at < $1`, cutoff)
	}
	return nil
}

func (service *service) feed(w http.ResponseWriter, r *http.Request) {
	if service.cfg.FeedToken != "" && r.Header.Get("X-Hunter-Feed-Token") != service.cfg.FeedToken {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthorized"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || len(body) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "bad_request"})
		return
	}
	var payload struct {
		Event  string          `json:"event"`
		Data   json.RawMessage `json:"data"`
		SentAt string          `json:"sent_at"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Event == "" || len(payload.Data) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_event"})
		return
	}
	var offer qvapay.Offer
	if err := json.Unmarshal(payload.Data, &offer); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_offer"})
		return
	}
	service.streamRaw.Add(1)
	service.handleOffer(payload.Event, offer, payload.SentAt, "webhook")
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
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
	case r.Method == http.MethodPost && r.URL.Path == "/feed":
		service.feed(w, r)
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
	if service.streamConnected.Load() {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	maxAge := int64(15)
	if intervalMS := service.pollInterval.Load(); intervalMS > 0 {
		maxAge = 3*intervalMS/1000 + 5
	}
	last := service.lastPollAt.Load()
	if last == 0 || time.Now().Unix()-last > maxAge {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "sin feed ni poll reciente"})
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
	fmt.Fprintf(w, "# HELP hunter_stream_connected Feed SSE conectado (1/0).\n# TYPE hunter_stream_connected gauge\nhunter_stream_connected %d\n", boolInt(service.streamConnected.Load()))
	fmt.Fprintf(w, "# HELP hunter_stream_raw_events_total Eventos SSE recibidos (incluye init).\n# TYPE hunter_stream_raw_events_total counter\nhunter_stream_raw_events_total %d\n", service.streamRaw.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_events_total Eventos SSE oportunidad recibidos.\n# TYPE hunter_stream_events_total counter\nhunter_stream_events_total %d\n", service.streamEvents.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_ignored_events_total Eventos SSE de salida o seguimiento descartados.\n# TYPE hunter_stream_ignored_events_total counter\nhunter_stream_ignored_events_total %d\n", service.streamIgnored.Load())
	fmt.Fprintf(w, "# HELP hunter_excluded_offers Ofertas excluidas por cancelación manual.\n# TYPE hunter_excluded_offers gauge\nhunter_excluded_offers %d\n", service.excludedCount())
	fmt.Fprintf(w, "# HELP hunter_stream_queue_depth Eventos SSE pendientes de persistir.\n# TYPE hunter_stream_queue_depth gauge\nhunter_stream_queue_depth %d\n", len(service.streamQueue))
	fmt.Fprintf(w, "# HELP hunter_batches_total Lotes de persistencia confirmados.\n# TYPE hunter_batches_total counter\nhunter_batches_total %d\n", service.persistBatches.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_errors_total Errores SSE acumulados.\n# TYPE hunter_stream_errors_total counter\nhunter_stream_errors_total %d\n", service.streamErrors.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_consecutive_errors Errores SSE desde la última conexión.\n# TYPE hunter_stream_consecutive_errors gauge\nhunter_stream_consecutive_errors %d\n", service.streamConsecutive.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_last_event_timestamp_seconds Último evento SSE (Unix).\n# TYPE hunter_stream_last_event_timestamp_seconds gauge\nhunter_stream_last_event_timestamp_seconds %d\n", service.streamLastAt.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_last_lag_ms Delivery lag del último evento SSE.\n# TYPE hunter_stream_last_lag_ms gauge\nhunter_stream_last_lag_ms %d\n", service.streamLastLagMS.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_last_decision_us Decisión local del último evento SSE (µs).\n# TYPE hunter_stream_last_decision_us gauge\nhunter_stream_last_decision_us %d\n", service.streamLastDecision.Load())
	fmt.Fprintf(w, "# HELP hunter_stream_last_enqueue_us Journalización del último evento SSE (µs).\n# TYPE hunter_stream_last_enqueue_us gauge\nhunter_stream_last_enqueue_us %d\n", service.streamLastEnqueue.Load())
	fmt.Fprintf(w, "# HELP hunter_last_latency_ms Latencia del último fetch o delivery lag SSE.\n# TYPE hunter_last_latency_ms gauge\nhunter_last_latency_ms %d\n", service.lastLatency.Load())
	fmt.Fprintf(w, "# HELP hunter_last_poll_timestamp_seconds Último poll (Unix).\n# TYPE hunter_last_poll_timestamp_seconds gauge\nhunter_last_poll_timestamp_seconds %d\n", service.lastPollAt.Load())
	fmt.Fprintf(w, "# HELP hunter_runtime_config_version Versión de configuración aplicada.\n# TYPE hunter_runtime_config_version gauge\nhunter_runtime_config_version %d\n", service.configVersion.Load())
	fmt.Fprintf(w, "# HELP hunter_runtime_paused Automatización pausada por el panel (1/0).\n# TYPE hunter_runtime_paused gauge\nhunter_runtime_paused %d\n", boolInt(service.paused.Load()))
	fmt.Fprintf(w, "# HELP hunter_poll_interval_ms Intervalo de polling efectivo.\n# TYPE hunter_poll_interval_ms gauge\nhunter_poll_interval_ms %d\n", service.pollInterval.Load())
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
