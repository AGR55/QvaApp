package edge

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// liveDefaultTransactionsLimit es el número de transacciones devuelto
	// cuando la query no indica limit.
	liveDefaultTransactionsLimit = 20
	// liveMaxTransactionsLimit acota el trabajo y el tamaño de la respuesta.
	liveMaxTransactionsLimit = 100
	// liveMarketOffersLimit acota las ofertas devueltas para un mercado. El
	// mercado es una vista puntual, no un histórico paginado.
	liveMarketOffersLimit = 100

	liveTransactionsPath = "/api/live/transactions"
	liveMarketsPrefix    = "/api/live/markets/"
)

// liveCoinPattern restringe el parámetro :coin a un único segmento simple. Se
// valida después de autenticar y antes de consultar Postgres.
var liveCoinPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// Identificadores internos de ruta. No forman parte del contrato HTTP.
const (
	liveRouteNone = iota
	liveRouteMarket
	liveRouteTransactions
)

// LiveMarket es la vista puntual de un mercado: la moneda solicitada y sus
// ofertas más recientes leídas en modo read-only.
type LiveMarket struct {
	Coin   string            `json:"coin"`
	Offers []LiveMarketOffer `json:"offers"`
}

// LiveMarketOffer es una oferta QvaPay del inventario más reciente. Todos los
// importes viajan como texto para no perder precisión.
type LiveMarketOffer struct {
	UUID       string `json:"uuid"`
	Type       string `json:"type"`
	Status     string `json:"status"`
	Amount     string `json:"amount"`
	Receive    string `json:"receive"`
	Rate       string `json:"rate"`
	CapturedAt int64  `json:"capturedAt"`
}

// LiveTransaction es una transacción QvaPay tal como la guarda el snapshot
// read-only. CreatedAt y UpdatedAt conservan el texto original de QvaPay.
type LiveTransaction struct {
	UUID        string `json:"uuid"`
	Amount      string `json:"amount"`
	Status      string `json:"status"`
	Description string `json:"description"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
	CapturedAt  int64  `json:"capturedAt"`
}

// LiveStore es la fuente de datos de solo lectura de las rutas live.
type LiveStore interface {
	Market(ctx context.Context, coin string) (LiveMarket, error)
	Transactions(ctx context.Context, limit int) ([]LiveTransaction, error)
}

// LiveAPI expone las rutas live de solo lectura del dashboard web. Toda
// petición exige la cookie de sesión emitida por SessionHandler; el token
// nunca se devuelve ni se registra.
//
// Rutas:
//
//	GET /api/live/markets/:coin
//	GET /api/live/transactions?limit=20
//
// :coin debe cumplir [A-Za-z0-9_-]{1,32}; un valor con otro formato responde
// 400 y un segmento ausente o adicional responde 404. limit se recorta al
// rango 1..100; valores ausentes o no numéricos usan 20. Cualquier otro método
// responde 405 y cualquier otra ruta 404, siempre JSON.
type LiveAPI struct {
	Sessions *SessionManager
	Store    LiveStore
	Now      func() time.Time
}

// liveResponse envuelve todos los datos en una clave "data" para poder añadir
// metadatos en el futuro sin romper el contrato.
type liveResponse struct {
	Data any `json:"data"`
}

func (api *LiveAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	route, coin, ok := parseLiveRoute(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	if !api.authenticated(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}

	if route == liveRouteMarket && !liveCoinPattern.MatchString(coin) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_coin"})
		return
	}

	if api.Store == nil {
		writeLiveUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	switch route {
	case liveRouteMarket:
		api.market(w, ctx, coin)
	case liveRouteTransactions:
		api.transactions(w, ctx, liveLimit(r))
	}
}

// parseLiveRoute reconoce las dos rutas live. Para mercados exige exactamente
// un segmento no vacío después del prefijo: un segmento ausente, vacío o
// adicional se trata como ruta desconocida para no confundirlo con un coin
// inválido.
func parseLiveRoute(urlPath string) (int, string, bool) {
	if urlPath == liveTransactionsPath {
		return liveRouteTransactions, "", true
	}
	coin, found := strings.CutPrefix(urlPath, liveMarketsPrefix)
	if !found || coin == "" || strings.Contains(coin, "/") {
		return liveRouteNone, "", false
	}
	return liveRouteMarket, coin, true
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *LiveAPI) authenticated(r *http.Request) bool {
	if api.Sessions == nil {
		return false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	now := time.Now
	if api.Now != nil {
		now = api.Now
	}
	_, err = api.Sessions.Verify(cookie.Value, now())
	return err == nil
}

func (api *LiveAPI) market(w http.ResponseWriter, ctx context.Context, coin string) {
	market, err := api.Store.Market(ctx, coin)
	if err != nil {
		writeLiveUnavailable(w)
		return
	}
	if market.Coin == "" {
		market.Coin = coin
	}
	if market.Offers == nil {
		market.Offers = []LiveMarketOffer{}
	}
	writeJSON(w, http.StatusOK, liveResponse{Data: market})
}

func (api *LiveAPI) transactions(w http.ResponseWriter, ctx context.Context, limit int) {
	transactions, err := api.Store.Transactions(ctx, limit)
	if err != nil {
		writeLiveUnavailable(w)
		return
	}
	if transactions == nil {
		transactions = []LiveTransaction{}
	}
	writeJSON(w, http.StatusOK, liveResponse{Data: transactions})
}

// liveLimit normaliza el parámetro limit: ausente o inválido usa el valor por
// defecto y los valores fuera de rango se recortan a 1..100.
func liveLimit(r *http.Request) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return liveDefaultTransactionsLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return liveDefaultTransactionsLimit
	}
	if limit < 1 {
		return 1
	}
	if limit > liveMaxTransactionsLimit {
		return liveMaxTransactionsLimit
	}
	return limit
}

func writeLiveUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

// PostgresLiveStore lee las tablas shadow con SELECT parametrizados. No
// escribe ni abre transacciones de escritura; el pool debe apuntar a una
// sesión de solo lectura cuando se use en producción.
type PostgresLiveStore struct {
	Pool *pgxpool.Pool
}

// Market devuelve las últimas ofertas de coin ordenadas por captured_at
// descendente. Sin filas devuelve un mercado con Offers vacío, no un error.
func (store *PostgresLiveStore) Market(
	ctx context.Context,
	coin string,
) (LiveMarket, error) {
	if store == nil || store.Pool == nil {
		return LiveMarket{}, errors.New("edge: live store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT offer_uuid, type, status, amount, receive, rate, captured_at
		FROM shadow.qvapay_offers
		WHERE coin = $1
		ORDER BY captured_at DESC, offer_uuid
		LIMIT $2`, coin, liveMarketOffersLimit)
	if err != nil {
		return LiveMarket{}, err
	}
	defer rows.Close()

	market := LiveMarket{Coin: coin, Offers: make([]LiveMarketOffer, 0)}
	for rows.Next() {
		var offer LiveMarketOffer
		if err := rows.Scan(
			&offer.UUID, &offer.Type, &offer.Status, &offer.Amount,
			&offer.Receive, &offer.Rate, &offer.CapturedAt,
		); err != nil {
			return LiveMarket{}, err
		}
		market.Offers = append(market.Offers, offer)
	}
	if err := rows.Err(); err != nil {
		return LiveMarket{}, err
	}
	return market, nil
}

// Transactions devuelve las transacciones más recientes por captured_at. Sin
// filas devuelve un slice vacío, no nil.
func (store *PostgresLiveStore) Transactions(
	ctx context.Context,
	limit int,
) ([]LiveTransaction, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: live store sin pool")
	}
	if limit <= 0 {
		return []LiveTransaction{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT transaction_uuid, amount, status, description,
		       created_at, updated_at, captured_at
		FROM shadow.qvapay_transactions
		ORDER BY captured_at DESC, transaction_uuid
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	transactions := make([]LiveTransaction, 0, limit)
	for rows.Next() {
		var transaction LiveTransaction
		if err := rows.Scan(
			&transaction.UUID, &transaction.Amount, &transaction.Status,
			&transaction.Description, &transaction.CreatedAt,
			&transaction.UpdatedAt, &transaction.CapturedAt,
		); err != nil {
			return nil, err
		}
		transactions = append(transactions, transaction)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return transactions, nil
}
