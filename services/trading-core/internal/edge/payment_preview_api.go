package edge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

var paymentPreviewUUIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

var assistedPaymentMarkets = map[string]struct {
	currency string
	kind     string
}{
	"BANK_CUP": {"CUP", "card"},
	"CLASICA":  {"USD", "card"},
	"ETECSA":   {"CUP", "phone"},
}

type paymentPreviewOperation struct {
	UUID           string
	Coin           string
	Amount         float64
	Receive        float64
	State          string
	CounterpartyID string
	OrderUUID      string
}

type PaymentOperationStore interface {
	Lookup(ctx context.Context, uuid string) (paymentPreviewOperation, bool, error)
}

type PostgresPaymentOperationStore struct {
	Pool *pgxpool.Pool
}

func (store *PostgresPaymentOperationStore) Lookup(ctx context.Context, uuid string) (paymentPreviewOperation, bool, error) {
	if store == nil || store.Pool == nil {
		return paymentPreviewOperation{}, false, fmt.Errorf("store sin pool")
	}
	var operation paymentPreviewOperation
	err := store.Pool.QueryRow(ctx, `
		SELECT uuid, coin, amount, receive, state,
		       COALESCE(counterparty_id,''), COALESCE(order_uuid,'')
		FROM shadow.local_operations WHERE uuid = $1`, uuid,
	).Scan(&operation.UUID, &operation.Coin, &operation.Amount, &operation.Receive,
		&operation.State, &operation.CounterpartyID, &operation.OrderUUID)
	if err == pgx.ErrNoRows {
		return paymentPreviewOperation{}, false, nil
	}
	if err != nil {
		return paymentPreviewOperation{}, false, err
	}
	return operation, true, nil
}

type PaymentReader interface {
	User(ctx context.Context) (qvapay.User, error)
	Offer(ctx context.Context, uuid string) (qvapay.Offer, error)
}

type PaymentPreviewAPI struct {
	MobileAuth *MobileAuthAPI
	Reader     PaymentReader
	Store      PaymentOperationStore
	Now        func() time.Time
}

func (api *PaymentPreviewAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}
	if api.Reader == nil || api.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Pago asistido no disponible."})
		return
	}
	if api.MobileAuth == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Operador móvil no autorizado."})
		return
	}
	if _, ok := api.MobileAuth.AuthorizeOperatorRead(w, r); !ok {
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/mobile/operations/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[1] != "payment-preview" || !paymentPreviewUUIDPattern.MatchString(parts[0]) {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	api.preview(w, r, parts[0])
}

func (api *PaymentPreviewAPI) preview(w http.ResponseWriter, r *http.Request, uuid string) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	operation, ok, err := api.Store.Lookup(ctx, uuid)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Pago asistido no disponible."})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "No existe una operación propia con esa oferta."})
		return
	}
	order := strings.TrimSpace(r.URL.Query().Get("order"))
	if order == "" {
		order = operation.OrderUUID
	}
	switch operation.State {
	case "applied", "acknowledged", "processing":
	default:
		writePaymentConflict(w, "La operación ya no admite preparar un pago.")
		return
	}
	support, ok := assistedPaymentMarkets[operation.Coin]
	if !ok {
		writePaymentConflict(w, "Este mercado o moneda no admite pago asistido.")
		return
	}
	profile, err := api.Reader.User(ctx)
	if err != nil {
		writePaymentConflict(w, "No se pudo verificar la identidad de la cuenta.")
		return
	}
	offer, err := api.Reader.Offer(ctx, uuid)
	if err != nil || offer.Coin != operation.Coin {
		writePaymentConflict(w, "La oferta consultada no coincide con la operación.")
		return
	}
	if order != "" && offer.OfferKind != "flexible" {
		writePaymentConflict(w, "La oferta requiere identificar su orden de rango.")
		return
	}
	creator := offerOwnerUUID(offer)
	creatorFromUser := offerRawUUID(offer.User, "uuid")
	if creatorFromUser != "" && offer.OwnerUUID != "" && creatorFromUser != offer.OwnerUUID {
		writePaymentConflict(w, "QvaPay devolvió propietarios incompatibles.")
		return
	}
	if creator == "" {
		creator = creatorFromUser
	}
	taker := offerPeerUUID(offer)
	if order != "" {
		child := findOrder(offer.Orders, order)
		if child == nil {
			writePaymentConflict(w, "QvaPay no devolvió la orden exacta; no se usará el importe del padre.")
			return
		}
		taker = offerRawUUID(child.Taker, "uuid")
		if !decimalEqual(child.Amount, operation.Amount) || !decimalEqual(child.Receive, operation.Receive) ||
			(child.Status != "" && child.Status != "processing") {
			writePaymentConflict(w, "El estado o los importes cambiaron. Actualiza y revisa la operación.")
			return
		}
	} else if offer.Status != "processing" || !decimalEqual(offer.Amount, operation.Amount) ||
		!decimalEqual(offer.Receive, operation.Receive) {
		writePaymentConflict(w, "El estado o los importes cambiaron. Actualiza y revisa la operación.")
		return
	}
	if taker != strings.TrimSpace(profile.UUID) || offer.Type != "sell" {
		writePaymentConflict(w, "No se pudo verificar que seas el pagador de esta contraparte.")
		return
	}
	if creator == "" || creator == strings.TrimSpace(profile.UUID) || creator != operation.CounterpartyID {
		writePaymentConflict(w, "No se pudo verificar que seas el pagador de esta contraparte.")
		return
	}
	if operation.Receive <= 0 || operation.Receive > 1e9 {
		writePaymentConflict(w, "El importe fiat no se puede representar exactamente con dos decimales.")
		return
	}
	amountText := fmt.Sprintf("%.2f", operation.Receive)
	if parsed, err := strconvParse(amountText); err != nil || parsed != operation.Receive {
		writePaymentConflict(w, "El importe fiat no se puede representar exactamente con dos decimales.")
		return
	}
	destination, confirmationPhone, err := paymentDestination(offer.Details, support.kind)
	if err != nil {
		writePaymentConflict(w, err.Error())
		return
	}
	checkedAt := api.now().UnixMilli()
	data := map[string]any{
		"uuid": uuid, "orderUuid": nullIfEmpty(order), "market": operation.Coin,
		"currency": support.currency, "amount": amountText, "kind": support.kind,
		"destination": destination, "counterpartyId": creator,
	}
	encoded, _ := json.Marshal(data)
	sum := sha256.Sum256(encoded)
	response := map[string]any{}
	for key, value := range data {
		response[key] = value
	}
	response["confirmationPhone"] = confirmationPhone
	response["fingerprint"] = hex.EncodeToString(sum[:])
	response["checkedAt"] = checkedAt
	response["expiresAt"] = checkedAt + 120_000
	response["execution"] = "form_review"
	writeJSON(w, http.StatusOK, map[string]any{"data": response})
}

func writePaymentConflict(w http.ResponseWriter, message string) {
	writeJSON(w, http.StatusConflict, map[string]any{"error": message})
}

func (api *PaymentPreviewAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func offerOwnerUUID(offer qvapay.Offer) string {
	if uuid := offerRawUUID(offer.User, "uuid"); uuid != "" {
		return uuid
	}
	return offer.OwnerUUID
}

func offerPeerUUID(offer qvapay.Offer) string {
	return offerRawUUID(offer.Peer, "uuid")
}

func offerRawUUID(raw json.RawMessage, key string) string {
	if len(raw) == 0 {
		return ""
	}
	var object map[string]any
	if json.Unmarshal(raw, &object) != nil {
		return ""
	}
	value, _ := object[key].(string)
	return strings.TrimSpace(value)
}

func findOrder(orders []qvapay.OfferOrder, uuid string) *qvapay.OfferOrder {
	for index := range orders {
		if orders[index].UUID == uuid {
			return &orders[index]
		}
	}
	return nil
}

func decimalEqual(value interface{ Format(int) string }, number float64) bool {
	parsed, err := strconvParse(value.Format(8))
	return err == nil && parsed == number
}

func strconvParse(text string) (float64, error) {
	return strconv.ParseFloat(text, 64)
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// paymentDestination replica las comprobaciones estrictas del TS: una sola
// tarjeta de 16 dígitos o un solo móvil cubano de 8 dígitos.
func paymentDestination(details map[string]any, kind string) (string, any, error) {
	if len(details) == 0 {
		return "", nil, fmt.Errorf("la oferta no tiene datos de pago verificables")
	}
	cards := map[string]struct{}{}
	phones := map[string]struct{}{}
	for name, raw := range details {
		label := strings.ToLower(strings.NewReplacer("_", " ", "-", " ").Replace(name))
		if regexp.MustCompile(`\b(origen|emisor|pagador|sender)\b`).MatchString(label) {
			continue
		}
		cardField := regexp.MustCompile(`\b(cuenta|tarjeta|account|card)\b`).MatchString(label)
		phoneField := regexp.MustCompile(`\b(telefono|movil|celular|phone|telephone)\b`).MatchString(label)
		if !cardField && !phoneField {
			continue
		}
		text, ok := raw.(string)
		if !ok || strings.TrimSpace(text) == "" || len(text) > 120 {
			return "", nil, fmt.Errorf("hay un campo de pago vacío o inválido en la oferta")
		}
		text = strings.TrimSpace(text)
		if cardField && phoneField {
			return "", nil, fmt.Errorf("la oferta mezcla tarjeta y teléfono en un mismo campo; revisa los datos")
		}
		if cardField {
			if !regexp.MustCompile(`^[0-9 -]+$`).MatchString(text) {
				return "", nil, fmt.Errorf("la tarjeta publicada no es un número completo y único")
			}
			normalized := strings.NewReplacer(" ", "", "-", "").Replace(text)
			if len(normalized) != 16 || allSameDigit(normalized) {
				return "", nil, fmt.Errorf("se necesita una tarjeta completa de 16 dígitos; esta cuenta requiere revisión manual")
			}
			cards[normalized] = struct{}{}
		} else {
			if !regexp.MustCompile(`^\+?[0-9 ()-]+$`).MatchString(text) {
				return "", nil, fmt.Errorf("el teléfono publicado contiene datos no válidos")
			}
			normalized := strings.NewReplacer(" ", "", "(", "", ")", "", "-", "").Replace(text)
			normalized = strings.TrimPrefix(strings.TrimPrefix(normalized, "+53"), "53")
			if !regexp.MustCompile(`^5[0-9]{7}$`).MatchString(normalized) {
				return "", nil, fmt.Errorf("se necesita un único móvil cubano de 8 dígitos")
			}
			phones[normalized] = struct{}{}
		}
	}
	if len(cards) > 1 || len(phones) > 1 {
		return "", nil, fmt.Errorf("la oferta contiene más de un destino de pago; no se elegirá uno automáticamente")
	}
	if kind == "card" {
		if len(cards) != 1 {
			return "", nil, fmt.Errorf("no se encontró una tarjeta única en los campos de la oferta")
		}
		var phone any
		for value := range phones {
			phone = value
		}
		for value := range cards {
			return value, phone, nil
		}
	}
	if len(phones) != 1 {
		return "", nil, fmt.Errorf("no se encontró un móvil destinatario único en los campos de la oferta")
	}
	for value := range phones {
		return value, nil, nil
	}
	return "", nil, fmt.Errorf("no se encontró un destino de pago")
}

func allSameDigit(value string) bool {
	if value == "" {
		return false
	}
	for index := 1; index < len(value); index++ {
		if value[index] != value[0] {
			return false
		}
	}
	return true
}
