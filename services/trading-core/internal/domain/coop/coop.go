// Package coop contiene el menú cooperativo puro de `src/cooperative-menu.ts`:
// acciones codificadas, validación y sesiones de aportación. No hace I/O.
package coop

//lint:file-ignore ST1005 los mensajes son contractuales y deben coincidir con el oráculo

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

const CallbackPrefix = "coop:"

var (
	marketPattern = regexp.MustCompile(`^[A-Z0-9_]{2,40}$`)
	tokenPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,24}$`)
	amountPattern = regexp.MustCompile(`^\d+(?:\.\d+)?$`)
)

// Action es una acción cooperativa.
type Action struct {
	Type  string
	Coin  string
	Token string
}

// Encode serializa una acción y aplica el límite de 64 bytes.
func Encode(action Action) (string, error) {
	var encoded string
	switch action.Type {
	case "home":
		encoded = "coop:home"
	case "refresh":
		encoded = "coop:refresh"
	case "edit":
		coin, err := validateMarket(action.Coin)
		if err != nil {
			return "", err
		}
		encoded = "coop:e:" + coin
	case "withdraw":
		coin, err := validateMarket(action.Coin)
		if err != nil {
			return "", err
		}
		encoded = "coop:w:" + coin
	case "withdraw-confirm":
		coin, err := validateMarket(action.Coin)
		if err != nil {
			return "", err
		}
		encoded = "coop:x:" + coin
	case "confirm":
		token, err := validateToken(action.Token)
		if err != nil {
			return "", err
		}
		encoded = "coop:y:" + token
	case "cancel":
		token, err := validateToken(action.Token)
		if err != nil {
			return "", err
		}
		encoded = "coop:n:" + token
	default:
		return "", errors.New("Acción cooperativa inválida.")
	}
	if len([]byte(encoded)) > 64 {
		return "", errors.New("La acción cooperativa supera el límite permitido.")
	}
	return encoded, nil
}

// Decode interpreta una acción cooperativa.
func Decode(data string) (Action, error) {
	parts := strings.Split(data, ":")
	if len(parts) < 2 || parts[0] != "coop" {
		return Action{}, errors.New("Acción cooperativa inválida.")
	}
	if len(parts) == 2 && parts[1] == "home" {
		return Action{Type: "home"}, nil
	}
	if len(parts) == 2 && parts[1] == "refresh" {
		return Action{Type: "refresh"}, nil
	}
	if len(parts) == 3 && parts[1] == "e" {
		coin, err := validateMarket(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "edit", Coin: coin}, nil
	}
	if len(parts) == 3 && parts[1] == "w" {
		coin, err := validateMarket(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "withdraw", Coin: coin}, nil
	}
	if len(parts) == 3 && parts[1] == "x" {
		coin, err := validateMarket(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "withdraw-confirm", Coin: coin}, nil
	}
	if len(parts) == 3 && parts[1] == "y" {
		token, err := validateToken(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "confirm", Token: token}, nil
	}
	if len(parts) == 3 && parts[1] == "n" {
		token, err := validateToken(parts[2])
		if err != nil {
			return Action{}, err
		}
		return Action{Type: "cancel", Token: token}, nil
	}
	return Action{}, errors.New("Acción cooperativa inválida.")
}

// Session es una aportación en curso.
type Session struct {
	Stage   string
	Token   string
	Coin    string
	Price   *decimal.Value
	Minimal *decimal.Value
}

// Draft es la aportación confirmada.
type Draft struct {
	Coin    string
	Price   decimal.Value
	Minimal decimal.Value
}

// Sessions conserva las aportaciones pendientes por chat.
type Sessions struct {
	pending     map[string]Session
	createToken func() string
}

// NewSessions crea el gestor con el generador de tokens inyectado.
func NewSessions(createToken func() string) *Sessions {
	return &Sessions{pending: map[string]Session{}, createToken: createToken}
}

// Begin inicia una aportación.
func (sessions *Sessions) Begin(chatID, coin string) (Session, error) {
	normalized, err := validateMarket(coin)
	if err != nil {
		return Session{}, err
	}
	session := Session{Stage: "price", Token: sessions.createToken(), Coin: normalized}
	sessions.pending[chatID] = session
	return session, nil
}

// Current devuelve la sesión pendiente.
func (sessions *Sessions) Current(chatID string) (Session, bool) {
	session, ok := sessions.pending[chatID]
	return session, ok
}

// Accept procesa precio o mínimo.
func (sessions *Sessions) Accept(chatID, text string) (Session, error) {
	current, ok := sessions.pending[chatID]
	if !ok || current.Stage == "confirm" {
		return Session{}, errors.New("No hay una aportación esperando datos.")
	}
	value, err := positiveNumber(text)
	if err != nil {
		return Session{}, err
	}
	next := current
	if current.Stage == "price" {
		next.Price = &value
		next.Stage = "minimal"
	} else if current.Stage == "minimal" {
		next.Minimal = &value
		next.Stage = "confirm"
	}
	sessions.pending[chatID] = next
	return next, nil
}

// Confirm cierra la aportación con el token vigente.
func (sessions *Sessions) Confirm(chatID, confirmationToken string) (Draft, error) {
	current, ok := sessions.pending[chatID]
	if !ok || current.Stage != "confirm" || current.Token != confirmationToken ||
		current.Price == nil || current.Minimal == nil {
		return Draft{}, errors.New("Esta confirmación cooperativa ya no está vigente.")
	}
	delete(sessions.pending, chatID)
	return Draft{Coin: current.Coin, Price: *current.Price, Minimal: *current.Minimal}, nil
}

// Cancel descarta la sesión; con token exige que coincida.
func (sessions *Sessions) Cancel(chatID string, confirmationToken *string) (Session, bool, error) {
	current, ok := sessions.pending[chatID]
	if !ok {
		return Session{}, false, nil
	}
	if confirmationToken != nil && current.Token != *confirmationToken {
		return Session{}, false, errors.New("Esta edición cooperativa ya no está vigente.")
	}
	delete(sessions.pending, chatID)
	return current, true, nil
}

func positiveNumber(text string) (decimal.Value, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(text), ",", ".")
	if !amountPattern.MatchString(normalized) {
		return decimal.Value{}, errors.New("Escribe un importe positivo usando solo números.")
	}
	value, err := decimal.Parse(normalized)
	if err != nil {
		return decimal.Value{}, errors.New("Escribe un importe positivo usando solo números.")
	}
	if value.Sign() <= 0 {
		return decimal.Value{}, errors.New("El importe debe ser mayor que cero.")
	}
	return value, nil
}

func validateMarket(value string) (string, error) {
	if marketPattern.MatchString(value) {
		return value, nil
	}
	return "", fmt.Errorf("Mercado cooperativo inválido.")
}

func validateToken(value string) (string, error) {
	if tokenPattern.MatchString(value) {
		return value, nil
	}
	return "", fmt.Errorf("Confirmación cooperativa inválida.")
}
