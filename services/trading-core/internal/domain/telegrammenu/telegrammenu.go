// Package telegrammenu contiene el menú de cacería puro de
// `src/telegram-menu.ts`: comandos, acciones codificadas, tasas exactas y
// sesiones de edición. No hace I/O.
package telegrammenu

//lint:file-ignore ST1005 los mensajes son contractuales y deben coincidir con el oráculo

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

const CallbackPrefix = "hunt:"

// Command es un comando nativo de Telegram.
type Command struct {
	Command     string
	Description string
}

// Commands es el menú declarado.
var Commands = []Command{
	{"panel", "Centro de operaciones"},
	{"balance", "Saldo disponible en QvaPay"},
	{"hunting", "Configurar las cacerías"},
	{"network", "Red cooperativa entre bots"},
	{"coop", "Gestionar mi aporte cooperativo"},
	{"markets", "Consultar mercados P2P"},
	{"offers", "Administrar mis ofertas"},
	{"recovery", "Conciliar, registrar evidencia y reconocer avisos"},
	{"operations", "Operaciones activas"},
	{"strategy", "Estrategia y límites actuales"},
	{"automation", "Activar o pausar automatización"},
	{"scan", "Escanear los mercados ahora"},
	{"logs", "Eventos recientes del bot"},
	{"diagnostico", "Por qué se toman o descartan ofertas"},
	{"historial", "Movimientos y saldos del fiat"},
	{"salud", "Estado del feed, medianas y latencia"},
	{"rentabilidad", "Resultado documentado y estimado por moneda"},
	{"simular", "Comparar precios sin cambiar las cacerías"},
	{"help", "Ayuda y comandos avanzados"},
}

var (
	marketPattern = regexp.MustCompile(`^[A-Z0-9_]{2,40}$`)
	tokenPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,24}$`)
	ratePattern   = regexp.MustCompile(`^\d+(?:\.\d+)?$`)
)

// Action es una acción de cacería.
type Action struct {
	Type  string
	Side  string
	Coin  string
	Token string
}

// Encode serializa una acción y aplica el límite de 64 bytes.
func Encode(action Action) (string, error) {
	var encoded string
	switch action.Type {
	case "home":
		encoded = "hunt:home"
	case "global-toggle":
		side, err := validateSide(action.Side)
		if err != nil {
			return "", err
		}
		encoded = "hunt:g:" + side
	case "market":
		coin, err := validateMarket(action.Coin)
		if err != nil {
			return "", err
		}
		encoded = "hunt:m:" + coin
	case "market-toggle":
		side, err := validateSide(action.Side)
		if err != nil {
			return "", err
		}
		coin, err := validateMarket(action.Coin)
		if err != nil {
			return "", err
		}
		encoded = "hunt:t:" + side + ":" + coin
	case "rate-edit":
		side, err := validateSide(action.Side)
		if err != nil {
			return "", err
		}
		coin, err := validateMarket(action.Coin)
		if err != nil {
			return "", err
		}
		encoded = "hunt:e:" + side + ":" + coin
	case "rate-confirm":
		token, err := validateToken(action.Token)
		if err != nil {
			return "", err
		}
		encoded = "hunt:y:" + token
	case "rate-cancel":
		token, err := validateToken(action.Token)
		if err != nil {
			return "", err
		}
		encoded = "hunt:n:" + token
	default:
		return "", errors.New("Acción de cacería inválida.")
	}
	if len([]byte(encoded)) > 64 {
		return "", errors.New("La acción de Telegram supera el límite permitido.")
	}
	return encoded, nil
}

// Decode interpreta una acción de cacería.
func Decode(data string) (Action, error) {
	parts := strings.Split(data, ":")
	if len(parts) < 2 || parts[0] != "hunt" {
		return Action{}, errors.New("Acción de cacería inválida.")
	}
	if len(parts) == 2 && parts[1] == "home" {
		return Action{Type: "home"}, nil
	}
	if len(parts) == 3 && parts[1] == "g" {
		side, err := validateSide(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "global-toggle", Side: side}, nil
	}
	if len(parts) == 3 && parts[1] == "m" {
		coin, err := validateMarket(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "market", Coin: coin}, nil
	}
	if len(parts) == 4 && parts[1] == "t" {
		side, err := validateSide(parts[2])
		if err != nil {
			return Action{}, err
		}
		coin, err := validateMarket(parts[3])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "market-toggle", Side: side, Coin: coin}, nil
	}
	if len(parts) == 4 && parts[1] == "e" {
		side, err := validateSide(parts[2])
		if err != nil {
			return Action{}, err
		}
		coin, err := validateMarket(parts[3])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "rate-edit", Side: side, Coin: coin}, nil
	}
	if len(parts) == 3 && parts[1] == "y" {
		token, err := validateToken(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "rate-confirm", Token: token}, nil
	}
	if len(parts) == 3 && parts[1] == "n" {
		token, err := validateToken(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "rate-cancel", Token: token}, nil
	}
	return Action{}, errors.New("Acción de cacería inválida.")
}

// ParseExactRate convierte una tasa con punto o coma decimal.
func ParseExactRate(text string) (decimal.Value, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(text), ",", ".")
	if !ratePattern.MatchString(normalized) {
		return decimal.Value{}, errors.New("Escribe una tasa positiva usando solo números.")
	}
	value, err := decimal.Parse(normalized)
	if err != nil {
		return decimal.Value{}, errors.New("Escribe una tasa positiva usando solo números.")
	}
	if value.Sign() <= 0 {
		return decimal.Value{}, errors.New("La tasa debe ser mayor que cero.")
	}
	return value, nil
}

// Session es una edición de tasa pendiente.
type Session struct {
	Stage        string
	Token        string
	Coin         string
	Side         string
	PreviousRate decimal.Value
	ProposedRate *decimal.Value
}

// Sessions conserva las ediciones pendientes por chat.
type Sessions struct {
	pending     map[string]Session
	createToken func() string
}

// NewSessions crea el gestor con el generador de tokens inyectado.
func NewSessions(createToken func() string) *Sessions {
	return &Sessions{pending: map[string]Session{}, createToken: createToken}
}

// Begin inicia una edición de tasa.
func (sessions *Sessions) Begin(chatID, coin, side string, previousRate decimal.Value) (Session, error) {
	normalizedCoin, err := validateMarket(coin)
	if err != nil {
		return Session{}, err
	}
	normalizedSide, err := validateSide(side)
	if err != nil {
		return Session{}, err
	}
	session := Session{
		Stage:        "input",
		Token:        sessions.createToken(),
		Coin:         normalizedCoin,
		Side:         normalizedSide,
		PreviousRate: previousRate,
	}
	sessions.pending[chatID] = session
	return session, nil
}

// Current devuelve la edición pendiente.
func (sessions *Sessions) Current(chatID string) (Session, bool) {
	session, ok := sessions.pending[chatID]
	return session, ok
}

// Propose valida la nueva tasa y pasa a confirmación.
func (sessions *Sessions) Propose(chatID, text string) (Session, error) {
	current, ok := sessions.pending[chatID]
	if !ok {
		return Session{}, errors.New("No hay una edición de tasa pendiente.")
	}
	proposed, err := ParseExactRate(text)
	if err != nil {
		return Session{}, err
	}
	next := current
	next.Stage = "confirm"
	next.ProposedRate = &proposed
	sessions.pending[chatID] = next
	return next, nil
}

// Confirm cierra la edición con el token vigente.
func (sessions *Sessions) Confirm(chatID, confirmationToken string) (Session, error) {
	current, ok := sessions.pending[chatID]
	if !ok || current.Stage != "confirm" || current.Token != confirmationToken {
		return Session{}, errors.New("Esta confirmación de tasa ya no está vigente.")
	}
	delete(sessions.pending, chatID)
	return current, nil
}

// Cancel descarta la edición; con token exige que coincida.
func (sessions *Sessions) Cancel(chatID string, confirmationToken *string) (Session, bool, error) {
	current, ok := sessions.pending[chatID]
	if !ok {
		return Session{}, false, nil
	}
	if confirmationToken != nil && current.Token != *confirmationToken {
		return Session{}, false, errors.New("Esta edición de tasa ya no está vigente.")
	}
	delete(sessions.pending, chatID)
	return current, true, nil
}

func validateSide(value string) (string, error) {
	if value == "buy" || value == "sell" {
		return value, nil
	}
	return "", fmt.Errorf("Lado de cacería inválido.")
}

func validateMarket(value string) (string, error) {
	if marketPattern.MatchString(value) {
		return value, nil
	}
	return "", fmt.Errorf("Mercado de cacería inválido.")
}

func validateToken(value string) (string, error) {
	if tokenPattern.MatchString(value) {
		return value, nil
	}
	return "", fmt.Errorf("Confirmación de tasa inválida.")
}
