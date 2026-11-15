package edge

// API de solo lectura para el informe de analítica de trading. Replica
// buildTradingAnalytics de src/trading-analytics.ts usando el bloque
// "analytics" del snapshot publicado por el exportador. No escribe, no emite
// cookies y no hace proxy al monolito TS.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"
)

const (
	// tradingAnalyticsPath es la única ruta servida por esta API.
	tradingAnalyticsPath = "/api/trading-analytics"
	// maxTradingAnalyticsSnapshotBytes acota el snapshot leído del disco. Un
	// archivo mayor se rechaza sin cargarlo entero en memoria.
	maxTradingAnalyticsSnapshotBytes = 8 << 20
	// tradingAnalyticsDefaultDays es el periodo usado cuando days falta o no
	// es 7, 30 o 90.
	tradingAnalyticsDefaultDays = 30
)

// Errores centinela. Nunca se escriben en la respuesta.
var (
	errTradingAnalyticsSnapshotTooLarge = errors.New("edge: snapshot de analítica demasiado grande")
	errTradingAnalyticsSnapshotInvalid  = errors.New("edge: snapshot de analítica inválido")
)

// tradingAnalyticsLocation es la zona usada para agrupar operaciones por día.
// En distroless puede faltar tzdata; en ese caso se usa un desplazamiento fijo
// UTC-5 (hora estándar de La Habana). El fallback es una aproximación
// documentada: durante el horario de verano la zona real es UTC-4.
var tradingAnalyticsLocation = loadTradingAnalyticsLocation()

func loadTradingAnalyticsLocation() *time.Location {
	if location, err := time.LoadLocation("America/Havana"); err == nil {
		return location
	}
	return time.FixedZone("CST", -5*3600)
}

// tradingAnalyticsSnapshot solo conserva el bloque analytics; el resto del
// documento del dashboard se ignora.
type tradingAnalyticsSnapshot struct {
	Analytics tradingAnalyticsInput `json:"analytics"`
}

// tradingAnalyticsInput replica la entrada de buildTradingAnalytics. Los
// valores numéricos son los ya normalizados por analyticsTransaction,
// analyticsOffer, analyticsFees y analyticsFiatMovements en el TS.
type tradingAnalyticsInput struct {
	AccountUUID   string                         `json:"accountUuid"`
	Transactions  []tradingAnalyticsTransaction  `json:"transactions"`
	Offers        []tradingAnalyticsOffer        `json:"offers"`
	Fees          []tradingAnalyticsFee          `json:"fees"`
	FiatMovements []tradingAnalyticsFiatMovement `json:"fiatMovements"`
	Markets       []tradingAnalyticsMarketConfig `json:"markets"`
}

// tradingAnalyticsTransaction es una transacción ya filtrada por el
// exportador. payerUuid/recipientUuid se distinguen de la cadena vacía con
// punteros, igual que la ausencia de la clave en el TS.
type tradingAnalyticsTransaction struct {
	UUID          string               `json:"uuid"`
	Amount        float64              `json:"amount"`
	CreatedAt     int64                `json:"createdAt"`
	UpdatedAt     int64                `json:"updatedAt"`
	PayerUUID     *string              `json:"payerUuid"`
	RecipientUUID *string              `json:"recipientUuid"`
	P2P           *tradingAnalyticsP2P `json:"p2p"`
}

// tradingAnalyticsP2P es la evidencia P2P de una transacción.
type tradingAnalyticsP2P struct {
	UUID    string  `json:"uuid"`
	Coin    string  `json:"coin"`
	Amount  float64 `json:"amount"`
	Receive float64 `json:"receive"`
	Status  string  `json:"status"`
}

// tradingAnalyticsOffer es una operación completada derivada de una oferta.
type tradingAnalyticsOffer struct {
	UUID        string  `json:"uuid"`
	Coin        string  `json:"coin"`
	Amount      float64 `json:"amount"`
	Receive     float64 `json:"receive"`
	Side        string  `json:"side"`
	CompletedAt int64   `json:"completedAt"`
	ParentUUID  string  `json:"parentUuid"`
}

// tradingAnalyticsFee es la evidencia documental de una comisión.
type tradingAnalyticsFee struct {
	UUID      string  `json:"uuid"`
	GrossQusd float64 `json:"grossQusd"`
	FeeQusd   float64 `json:"feeQusd"`
	Evidence  string  `json:"evidence"`
	Version   int64   `json:"version"`
	UpdatedAt int64   `json:"updatedAt"`
}

// tradingAnalyticsFiatMovement es un movimiento del ledger fiat.
type tradingAnalyticsFiatMovement struct {
	UUID      string  `json:"uuid"`
	Direction string  `json:"direction"`
	Amount    float64 `json:"amount"`
}

// tradingAnalyticsMarketConfig es la etiqueta pública de un mercado. Los
// campos opcionales usan punteros para reproducir el fallback al código.
type tradingAnalyticsMarketConfig struct {
	Code     string  `json:"code"`
	Label    *string `json:"label"`
	Currency *string `json:"currency"`
}

// tradingAnalyticsDaily es una fila del agregado diario.
type tradingAnalyticsDaily struct {
	Date     string  `json:"date"`
	Incoming float64 `json:"incoming"`
	Outgoing float64 `json:"outgoing"`
	Unknown  float64 `json:"unknown"`
	Count    int     `json:"count"`
	Bought   float64 `json:"bought"`
	Sold     float64 `json:"sold"`
}

// tradingAnalyticsMarketRow es el resultado FIFO por mercado.
type tradingAnalyticsMarketRow struct {
	Code                  string  `json:"code"`
	Label                 string  `json:"label"`
	Currency              string  `json:"currency"`
	Volume                float64 `json:"volume"`
	Count                 int     `json:"count"`
	Bought                float64 `json:"bought"`
	Sold                  float64 `json:"sold"`
	Unknown               float64 `json:"unknown"`
	FiatSpent             float64 `json:"fiatSpent"`
	FiatReceived          float64 `json:"fiatReceived"`
	EstimatedProfit       float64 `json:"estimatedProfit"`
	MatchedQusd           float64 `json:"matchedQusd"`
	UnmatchedSoldQusd     float64 `json:"unmatchedSoldQusd"`
	MatchedCost           float64 `json:"matchedCost"`
	DocumentedProfit      float64 `json:"documentedProfit"`
	DocumentedMatchedQusd float64 `json:"documentedMatchedQusd"`
	RecordedFeesQusd      float64 `json:"recordedFeesQusd"`
}

// tradingAnalyticsProfit es un punto de beneficio por día y divisa.
type tradingAnalyticsProfit struct {
	Date     string  `json:"date"`
	Currency string  `json:"currency"`
	Profit   float64 `json:"profit"`
}

// tradingAnalyticsCurrency agrega los mercados de una misma divisa.
type tradingAnalyticsCurrency struct {
	Currency              string  `json:"currency"`
	Profit                float64 `json:"profit"`
	MatchedQusd           float64 `json:"matchedQusd"`
	DocumentedProfit      float64 `json:"documentedProfit"`
	DocumentedMatchedQusd float64 `json:"documentedMatchedQusd"`
}

// tradingAnalyticsTotals resume las transacciones del periodo.
type tradingAnalyticsTotals struct {
	Count    int     `json:"count"`
	Incoming float64 `json:"incoming"`
	Outgoing float64 `json:"outgoing"`
	Unknown  float64 `json:"unknown"`
}

// tradingAnalyticsCoverage describe la calidad del histórico disponible.
type tradingAnalyticsCoverage struct {
	Transactions        int     `json:"transactions"`
	OldestAt            *int64  `json:"oldestAt"`
	UnknownDirection    int     `json:"unknownDirection"`
	UnmatchedSoldQusd   float64 `json:"unmatchedSoldQusd"`
	PartialPurchaseQusd float64 `json:"partialPurchaseQusd"`
}

// tradingAnalyticsSync replica el estado de sincronización del TS. El
// snapshot no incluye historial remoto, así que se publica como vacío.
type tradingAnalyticsSync struct {
	AccountKnown   bool `json:"accountKnown"`
	Complete       bool `json:"complete"`
	Limited        bool `json:"limited"`
	OffersComplete bool `json:"offersComplete"`
	OfferPages     int  `json:"offerPages"`
	Pages          int  `json:"pages"`
	UpdatedAt      any  `json:"updatedAt"`
}

// tradingAnalyticsReport es el contrato exacto de buildTradingAnalytics más los
// campos de historial que el TS añade en dashboard.tradingAnalytics. Esos
// campos no están en el snapshot y se publican de forma segura como vacíos.
type tradingAnalyticsReport struct {
	Days             int                         `json:"days"`
	Start            string                      `json:"start"`
	End              string                      `json:"end"`
	GeneratedAt      int64                       `json:"generatedAt"`
	Daily            []tradingAnalyticsDaily     `json:"daily"`
	Markets          []tradingAnalyticsMarketRow `json:"markets"`
	Profits          []tradingAnalyticsProfit    `json:"profits"`
	Currencies       []tradingAnalyticsCurrency  `json:"currencies"`
	Totals           tradingAnalyticsTotals      `json:"totals"`
	Volume           float64                     `json:"volume"`
	Completed        int                         `json:"completed"`
	Coverage         tradingAnalyticsCoverage    `json:"coverage"`
	BalanceHistory   []any                       `json:"balanceHistory"`
	PortfolioHistory []any                       `json:"portfolioHistory"`
	PortfolioStatus  any                         `json:"portfolioStatus"`
	Sync             tradingAnalyticsSync        `json:"sync"`
}

// tradingAnalyticsEnvelope es el sobre de la respuesta.
type tradingAnalyticsEnvelope struct {
	Data   tradingAnalyticsReport `json:"data"`
	Source string                 `json:"source"`
}

// tradingAnalyticsTrade es la operación unificada de transacciones y ofertas.
type tradingAnalyticsTrade struct {
	UUID        string
	Coin        string
	Qusd        float64
	NominalFiat float64
	Fiat        float64
	Side        string
	At          int64
}

// tradingAnalyticsLot es un lote de inventario para el FIFO.
type tradingAnalyticsLot struct {
	Amount     float64
	UnitCost   float64
	Documented bool
}

// TradingAnalyticsAPI sirve GET /api/trading-analytics desde el snapshot
// privado. Exige la cookie de sesión emitida por SessionHandler y calcula el
// informe en cada petición (sin caché).
//
// Un snapshot ausente o vacío produce un informe vacío válido con los días del
// periodo. Un JSON inválido, un archivo mayor de 8 MiB o un fallo de lectura
// producen 503 sin detalles. Cualquier otro método responde 405 y cualquier
// otra ruta 404, siempre JSON.
//
// Now permite inyectar el reloj en las pruebas; nil usa time.Now. El mismo
// reloj valida la sesión y fija el final del periodo.
type TradingAnalyticsAPI struct {
	Sessions *SessionManager
	File     string
	Now      func() time.Time
}

func (api *TradingAnalyticsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.URL.Path != tradingAnalyticsPath {
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

	snapshot, err := api.snapshot()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}

	now := api.now().UnixMilli()
	report := buildTradingAnalytics(snapshot.Analytics, tradingAnalyticsDays(r), now)
	writeJSON(w, http.StatusOK, tradingAnalyticsEnvelope{Data: report, Source: "sqlite"})
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *TradingAnalyticsAPI) authenticated(r *http.Request) bool {
	if api.Sessions == nil {
		return false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	_, err = api.Sessions.Verify(cookie.Value, api.now())
	return err == nil
}

// now devuelve el reloj inyectado o el del sistema.
func (api *TradingAnalyticsAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// tradingAnalyticsDays normaliza el parámetro days. Solo 7, 30 y 90 son
// válidos; cualquier otro valor usa 30.
func tradingAnalyticsDays(r *http.Request) int {
	raw := r.URL.Query().Get("days")
	if raw == "" {
		return tradingAnalyticsDefaultDays
	}
	days, err := strconv.Atoi(raw)
	if err != nil {
		return tradingAnalyticsDefaultDays
	}
	switch days {
	case 7, 30, 90:
		return days
	default:
		return tradingAnalyticsDefaultDays
	}
}

// snapshot lee y valida el documento publicado. Un archivo ausente o vacío es
// un snapshot vacío válido. Nunca devuelve el error de E/S al cliente.
func (api *TradingAnalyticsAPI) snapshot() (tradingAnalyticsSnapshot, error) {
	if api.File == "" {
		return tradingAnalyticsSnapshot{}, nil
	}

	file, err := os.Open(api.File)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return tradingAnalyticsSnapshot{}, nil
		}
		return tradingAnalyticsSnapshot{}, err
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, maxTradingAnalyticsSnapshotBytes+1))
	if err != nil {
		return tradingAnalyticsSnapshot{}, err
	}
	if len(raw) > maxTradingAnalyticsSnapshotBytes {
		return tradingAnalyticsSnapshot{}, errTradingAnalyticsSnapshotTooLarge
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return tradingAnalyticsSnapshot{}, nil
	}
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return tradingAnalyticsSnapshot{}, errTradingAnalyticsSnapshotInvalid
	}

	var snapshot tradingAnalyticsSnapshot
	if err := json.Unmarshal(trimmed, &snapshot); err != nil {
		return tradingAnalyticsSnapshot{}, errTradingAnalyticsSnapshotInvalid
	}
	return snapshot, nil
}

// tradingAnalyticsDay formatea el instante en la zona America/Havana como
// YYYY-MM-DD, equivalente a Intl.DateTimeFormat("en-CA", ...).
func tradingAnalyticsDay(at int64) string {
	return time.UnixMilli(at).In(tradingAnalyticsLocation).Format("2006-01-02")
}

// tradingAnalyticsDirection clasifica una transacción respecto de la cuenta.
func tradingAnalyticsDirection(tx tradingAnalyticsTransaction, account string) string {
	payer := tx.PayerUUID != nil && *tx.PayerUUID == account
	recipient := tx.RecipientUUID != nil && *tx.RecipientUUID == account
	if payer && recipient {
		return "unknown"
	}
	if recipient {
		return "incoming"
	}
	if payer {
		return "outgoing"
	}
	return "unknown"
}

// buildTradingAnalytics porta buildTradingAnalytics del TS. No redondea los
// importes: el TS tampoco lo hace.
func buildTradingAnalytics(input tradingAnalyticsInput, days int, now int64) tradingAnalyticsReport {
	if days < 0 {
		days = 0
	}
	account := input.AccountUUID
	end := tradingAnalyticsDay(now)
	base, err := time.Parse("2006-01-02", end)
	if err != nil {
		// No puede ocurrir: end siempre procede de Format. Se mantiene un
		// valor coherente sin pánico.
		base = time.UnixMilli(now).UTC()
	}
	base = base.Add(12 * time.Hour)
	startTime := base.AddDate(0, 0, -(days - 1))
	start := startTime.Format("2006-01-02")
	inPeriod := func(at int64) bool {
		day := tradingAnalyticsDay(at)
		return at <= now && day >= start && day <= end
	}

	daily := make([]tradingAnalyticsDaily, 0, days)
	for i := 0; i < days; i++ {
		daily = append(daily, tradingAnalyticsDaily{
			Date: startTime.AddDate(0, 0, i).Format("2006-01-02"),
		})
	}
	dailyIndex := make(map[string]*tradingAnalyticsDaily, len(daily))
	for i := range daily {
		dailyIndex[daily[i].Date] = &daily[i]
	}

	// Deduplicación por uuid conservando la posición del primer valor y el
	// último valor, como new Map(...) en el TS.
	seenTransactions := make(map[string]int, len(input.Transactions))
	unique := make([]tradingAnalyticsTransaction, 0, len(input.Transactions))
	for _, tx := range input.Transactions {
		if index, ok := seenTransactions[tx.UUID]; ok {
			unique[index] = tx
			continue
		}
		seenTransactions[tx.UUID] = len(unique)
		unique = append(unique, tx)
	}
	transactions := make([]tradingAnalyticsTransaction, 0, len(unique))
	for _, tx := range unique {
		if tx.CreatedAt <= now && tx.UpdatedAt <= now {
			transactions = append(transactions, tx)
		}
	}
	for _, tx := range transactions {
		if !inPeriod(tx.CreatedAt) {
			continue
		}
		row := dailyIndex[tradingAnalyticsDay(tx.CreatedAt)]
		if row == nil {
			continue
		}
		switch tradingAnalyticsDirection(tx, account) {
		case "incoming":
			row.Incoming += tx.Amount
		case "outgoing":
			row.Outgoing += tx.Amount
		default:
			row.Unknown += tx.Amount
		}
		row.Count++
	}

	// Un padre flexible es inventario; sus transacciones no son operaciones.
	rangeParents := make(map[string]bool)
	for _, offer := range input.Offers {
		if offer.ParentUUID != "" {
			rangeParents[offer.ParentUUID] = true
		}
	}

	groupOrder := make([]string, 0)
	groups := make(map[string][]tradingAnalyticsTransaction)
	for _, tx := range transactions {
		if tx.P2P == nil || tx.P2P.Status != "completed" {
			continue
		}
		if rangeParents[tx.P2P.UUID] {
			continue
		}
		if _, exists := groups[tx.P2P.UUID]; !exists {
			groupOrder = append(groupOrder, tx.P2P.UUID)
		}
		groups[tx.P2P.UUID] = append(groups[tx.P2P.UUID], tx)
	}

	fiatByUUID := make(map[string]tradingAnalyticsFiatMovement, len(input.FiatMovements))
	for _, movement := range input.FiatMovements {
		fiatByUUID[movement.UUID] = movement
	}
	feesByUUID := make(map[string]tradingAnalyticsFee, len(input.Fees))
	for _, fee := range input.Fees {
		feesByUUID[fee.UUID] = fee
	}

	// Unión de operaciones: primero transacciones y luego ofertas, con
	// deduplicación por uuid. El orden definitivo se aplica al final.
	trades := make([]tradingAnalyticsTrade, 0, len(groupOrder)+len(input.Offers))
	tradeIndex := make(map[string]int, cap(trades))
	addTrade := func(trade tradingAnalyticsTrade) {
		if index, ok := tradeIndex[trade.UUID]; ok {
			trades[index] = trade
			return
		}
		tradeIndex[trade.UUID] = len(trades)
		trades = append(trades, trade)
	}

	for _, uuid := range groupOrder {
		rows := groups[uuid]
		latest := rows[0]
		for _, row := range rows[1:] {
			if row.UpdatedAt > latest.UpdatedAt {
				latest = row
			}
		}
		p2p := latest.P2P
		movement, hasMovement := fiatByUUID[p2p.UUID]
		sides := make(map[string]bool)
		for _, row := range rows {
			if direction := tradingAnalyticsDirection(row, account); direction != "unknown" {
				sides[direction] = true
			}
		}
		side := "unknown"
		if hasMovement {
			if movement.Direction == "debit" {
				side = "incoming"
			} else {
				side = "outgoing"
			}
		} else if len(sides) == 1 {
			for direction := range sides {
				side = direction
			}
		}
		fiat := p2p.Receive
		if hasMovement {
			fiat = movement.Amount
		}
		addTrade(tradingAnalyticsTrade{
			UUID:        p2p.UUID,
			Coin:        p2p.Coin,
			Qusd:        p2p.Amount,
			NominalFiat: p2p.Receive,
			Fiat:        fiat,
			Side:        side,
			At:          latest.UpdatedAt,
		})
	}

	for _, offer := range input.Offers {
		if rangeParents[offer.UUID] {
			continue
		}
		fiat := offer.Receive
		if movement, ok := fiatByUUID[offer.UUID]; ok {
			fiat = movement.Amount
		}
		addTrade(tradingAnalyticsTrade{
			UUID:        offer.UUID,
			Coin:        offer.Coin,
			Qusd:        offer.Amount,
			NominalFiat: offer.Receive,
			Fiat:        fiat,
			Side:        offer.Side,
			At:          offer.CompletedAt,
		})
	}

	sort.Slice(trades, func(i, j int) bool {
		if trades[i].At != trades[j].At {
			return trades[i].At < trades[j].At
		}
		return trades[i].UUID < trades[j].UUID
	})

	// Mercados en orden de primera aparición; se filtran y ordenan al final.
	marketRows := make([]tradingAnalyticsMarketRow, 0)
	marketIndex := make(map[string]int)
	marketRow := func(coin string) *tradingAnalyticsMarketRow {
		if index, ok := marketIndex[coin]; ok {
			return &marketRows[index]
		}
		row := tradingAnalyticsMarketRow{
			Code:     coin,
			Label:    coin,
			Currency: coin,
		}
		for _, market := range input.Markets {
			if market.Code != coin {
				continue
			}
			if market.Label != nil {
				row.Label = *market.Label
			}
			if market.Currency != nil {
				row.Currency = *market.Currency
			}
			break
		}
		marketIndex[coin] = len(marketRows)
		marketRows = append(marketRows, row)
		return &marketRows[len(marketRows)-1]
	}

	inventory := make(map[string][]tradingAnalyticsLot)
	partialPurchaseQusd := 0.0
	profits := make([]tradingAnalyticsProfit, 0)
	profitIndex := make(map[string]int)

	for _, trade := range trades {
		row := marketRow(trade.Coin)
		selected := inPeriod(trade.At)
		lots := inventory[trade.Coin]
		day := dailyIndex[tradingAnalyticsDay(trade.At)]

		if selected {
			row.Volume += trade.Qusd
			row.Count++
			switch trade.Side {
			case "incoming":
				row.Bought += trade.Qusd
				row.FiatSpent += trade.Fiat
				if day != nil {
					day.Bought += trade.Qusd
				}
			case "outgoing":
				row.Sold += trade.Qusd
				row.FiatReceived += trade.Fiat
				if day != nil {
					day.Sold += trade.Qusd
				}
			default:
				row.Unknown += trade.Qusd
			}
		}

		fee, hasFee := feesByUUID[trade.UUID]
		validFee := hasFee &&
			fee.GrossQusd == trade.Qusd &&
			!math.IsNaN(fee.FeeQusd) &&
			!math.IsInf(fee.FeeQusd, 0) &&
			fee.FeeQusd >= 0 &&
			fee.FeeQusd < trade.Qusd
		movement, hasMovement := fiatByUUID[trade.UUID]

		if trade.Side == "incoming" {
			// Una contribución cooperativa no establece el coste ni la
			// propiedad de toda la operación acreditada. Su fiat parcial no
			// debe convertirse en lotes baratos.
			if hasMovement && movement.Direction == "debit" &&
				movement.Amount+1e-8 < trade.NominalFiat {
				if selected {
					partialPurchaseQusd += trade.Qusd
				}
				continue
			}
			net := trade.Qusd
			if validFee {
				net -= fee.FeeQusd
			}
			documented := validFee && hasMovement && movement.Direction == "debit" &&
				movement.Amount >= trade.NominalFiat
			lots = append(lots, tradingAnalyticsLot{
				Amount:     net,
				UnitCost:   trade.Fiat / net,
				Documented: documented,
			})
			inventory[trade.Coin] = lots
			if selected && validFee {
				row.RecordedFeesQusd += fee.FeeQusd
			}
		}

		if trade.Side != "outgoing" {
			continue
		}

		remaining := trade.Qusd
		cost := 0.0
		matched := 0.0
		documentedCost := 0.0
		documentedMatched := 0.0
		for remaining > 1e-8 && len(lots) > 0 {
			lot := &lots[0]
			used := math.Min(remaining, lot.Amount)
			cost += used * lot.UnitCost
			matched += used
			remaining -= used
			lot.Amount -= used
			if lot.Documented && hasMovement && movement.Direction == "credit" {
				documentedCost += used * lot.UnitCost
				documentedMatched += used
			}
			if lot.Amount < 1e-8 {
				lots = lots[1:]
			}
		}
		inventory[trade.Coin] = lots

		if selected {
			profit := matched*trade.Fiat/trade.Qusd - cost
			row.MatchedQusd += matched
			row.UnmatchedSoldQusd += remaining
			row.MatchedCost += cost
			row.EstimatedProfit += profit
			row.DocumentedMatchedQusd += documentedMatched
			row.DocumentedProfit += documentedMatched*trade.Fiat/trade.Qusd - documentedCost

			date := tradingAnalyticsDay(trade.At)
			key := date + ":" + row.Currency
			if index, ok := profitIndex[key]; ok {
				profits[index].Profit += profit
			} else {
				profitIndex[key] = len(profits)
				profits = append(profits, tradingAnalyticsProfit{
					Date:     date,
					Currency: row.Currency,
					Profit:   profit,
				})
			}
		}
	}

	selectedMarkets := make([]tradingAnalyticsMarketRow, 0, len(marketRows))
	for _, row := range marketRows {
		if row.Count != 0 {
			selectedMarkets = append(selectedMarkets, row)
		}
	}
	sort.SliceStable(selectedMarkets, func(i, j int) bool {
		return selectedMarkets[i].Volume > selectedMarkets[j].Volume
	})

	totals := tradingAnalyticsTotals{}
	for _, row := range daily {
		totals.Count += row.Count
		totals.Incoming += row.Incoming
		totals.Outgoing += row.Outgoing
		totals.Unknown += row.Unknown
	}

	currencyOrder := make([]string, 0)
	seenCurrency := make(map[string]bool)
	for _, row := range selectedMarkets {
		if !seenCurrency[row.Currency] {
			seenCurrency[row.Currency] = true
			currencyOrder = append(currencyOrder, row.Currency)
		}
	}
	currencies := make([]tradingAnalyticsCurrency, 0, len(currencyOrder))
	for _, currency := range currencyOrder {
		total := tradingAnalyticsCurrency{Currency: currency}
		for _, row := range selectedMarkets {
			if row.Currency != currency {
				continue
			}
			total.Profit += row.EstimatedProfit
			total.MatchedQusd += row.MatchedQusd
			total.DocumentedProfit += row.DocumentedProfit
			total.DocumentedMatchedQusd += row.DocumentedMatchedQusd
		}
		currencies = append(currencies, total)
	}

	volume := 0.0
	completed := 0
	unmatchedSoldQusd := 0.0
	for _, row := range selectedMarkets {
		volume += row.Volume
		completed += row.Count
		unmatchedSoldQusd += row.UnmatchedSoldQusd
	}

	var oldestAt *int64
	for _, tx := range transactions {
		if oldestAt == nil || tx.CreatedAt < *oldestAt {
			value := tx.CreatedAt
			oldestAt = &value
		}
	}
	unknownDirection := 0
	for _, tx := range transactions {
		if inPeriod(tx.CreatedAt) &&
			tradingAnalyticsDirection(tx, account) == "unknown" {
			unknownDirection++
		}
	}

	return tradingAnalyticsReport{
		Days:        days,
		Start:       start,
		End:         end,
		GeneratedAt: now,
		Daily:       daily,
		Markets:     selectedMarkets,
		Profits:     profits,
		Currencies:  currencies,
		Totals:      totals,
		Volume:      volume,
		Completed:   completed,
		Coverage: tradingAnalyticsCoverage{
			Transactions:        len(transactions),
			OldestAt:            oldestAt,
			UnknownDirection:    unknownDirection,
			UnmatchedSoldQusd:   unmatchedSoldQusd,
			PartialPurchaseQusd: partialPurchaseQusd,
		},
		BalanceHistory:   []any{},
		PortfolioHistory: []any{},
		PortfolioStatus:  nil,
		Sync: tradingAnalyticsSync{
			AccountKnown:   account != "",
			Complete:       false,
			Limited:        false,
			OffersComplete: false,
			OfferPages:     0,
			Pages:          0,
			UpdatedAt:      nil,
		},
	}
}
