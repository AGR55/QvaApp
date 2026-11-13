// Package decimal implementa aritmética decimal exacta para las reglas de
// dinero del dominio. Nunca usa float64 para importes: los números de entrada
// se convierten a `big.Rat` desde su representación JSON y los resultados se
// formatean con escala fija.
package decimal

import (
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// Value es un número racional exacto. El valor cero es válido.
type Value struct {
	rat *big.Rat
}

// Zero devuelve el cero.
func Zero() Value { return Value{} }

// FromInt construye un valor a partir de un entero.
func FromInt(value int64) Value {
	return Value{rat: new(big.Rat).SetInt64(value)}
}

// Parse convierte una representación decimal (incluida notación científica)
// en un valor exacto. No pasa por float64.
func Parse(text string) (Value, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Value{}, fmt.Errorf("número vacío")
	}
	rat, ok := new(big.Rat).SetString(text)
	if !ok {
		return Value{}, fmt.Errorf("número inválido: %q", text)
	}
	return Value{rat: rat}, nil
}

// MustParse es Parse para constantes controladas por el código.
func MustParse(text string) Value {
	value, err := Parse(text)
	if err != nil {
		panic(err)
	}
	return value
}

func (value Value) ratOrZero() *big.Rat {
	if value.rat == nil {
		return new(big.Rat)
	}
	return value.rat
}

// Add devuelve la suma exacta.
func (value Value) Add(other Value) Value {
	return Value{rat: new(big.Rat).Add(value.ratOrZero(), other.ratOrZero())}
}

// Sub devuelve la resta exacta.
func (value Value) Sub(other Value) Value {
	return Value{rat: new(big.Rat).Sub(value.ratOrZero(), other.ratOrZero())}
}

// Mul devuelve el producto exacto.
func (value Value) Mul(other Value) Value {
	return Value{rat: new(big.Rat).Mul(value.ratOrZero(), other.ratOrZero())}
}

// Div devuelve el cociente exacto. Rechaza el divisor cero.
func (value Value) Div(other Value) (Value, error) {
	if other.Sign() == 0 {
		return Value{}, fmt.Errorf("división por cero")
	}
	return Value{rat: new(big.Rat).Quo(value.ratOrZero(), other.ratOrZero())}, nil
}

// Abs devuelve el valor absoluto.
func (value Value) Abs() Value {
	return Value{rat: new(big.Rat).Abs(value.ratOrZero())}
}

// Neg devuelve el opuesto.
func (value Value) Neg() Value {
	return Value{rat: new(big.Rat).Neg(value.ratOrZero())}
}

// Cmp compara dos valores (-1, 0, 1).
func (value Value) Cmp(other Value) int {
	return value.ratOrZero().Cmp(other.ratOrZero())
}

// Sign devuelve -1, 0 o 1.
func (value Value) Sign() int {
	return value.ratOrZero().Sign()
}

// IsZero indica si el valor es cero.
func (value Value) IsZero() bool {
	return value.Sign() == 0
}

// Round redondea a `scale` decimales con mitad hacia fuera de cero. Para los
// importes del dominio (siempre no negativos) coincide con Math.round de JS.
func (value Value) Round(scale int) Value {
	if scale < 0 {
		panic("escala negativa")
	}
	factor := pow10(scale)
	scaled := new(big.Rat).Mul(value.ratOrZero(), new(big.Rat).SetInt(factor))
	rounded := roundHalfAway(scaled)
	return Value{rat: new(big.Rat).SetFrac(rounded, factor)}
}

// Floor devuelve el entero inmediatamente inferior.
func (value Value) Floor() Value {
	quotient, remainder := new(big.Int).QuoRem(value.ratOrZero().Num(), value.ratOrZero().Denom(), new(big.Int))
	if remainder.Sign() < 0 {
		quotient.Sub(quotient, big.NewInt(1))
	}
	return Value{rat: new(big.Rat).SetInt(quotient)}
}

// Ceil devuelve el entero inmediatamente superior.
func (value Value) Ceil() Value {
	quotient, remainder := new(big.Int).QuoRem(value.ratOrZero().Num(), value.ratOrZero().Denom(), new(big.Int))
	if remainder.Sign() > 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	return Value{rat: new(big.Rat).SetInt(quotient)}
}

// Format devuelve la representación con exactamente `scale` decimales.
func (value Value) Format(scale int) string {
	rounded := value.Round(scale)
	scaled := new(big.Rat).Mul(rounded.ratOrZero(), new(big.Rat).SetInt(pow10(scale)))
	integer := new(big.Int).Set(scaled.Num())
	sign := ""
	if integer.Sign() < 0 {
		sign = "-"
		integer.Abs(integer)
	}
	digits := integer.String()
	if scale == 0 {
		return sign + digits
	}
	if len(digits) <= scale {
		digits = strings.Repeat("0", scale-len(digits)+1) + digits
	}
	point := len(digits) - scale
	return sign + digits[:point] + "." + digits[point:]
}

// Compact devuelve la representación con hasta 8 decimales, sin ceros finales.
// Se usa para mensajes legibles; la evidencia canónica sigue usando Format(8).
func (value Value) Compact() string {
	text := value.Format(8)
	text = strings.TrimRight(text, "0")
	text = strings.TrimRight(text, ".")
	if text == "" || text == "-" {
		return "0"
	}
	return text
}

// Places devuelve los decimales significativos de un número JSON según la
// representación canónica de JS (`Number.toString`). Solo se usa para replicar
// la precisión configurada del índice; la aritmética sigue siendo exacta.
func Places(number string) (int, error) {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(number), 64)
	if err != nil {
		return 0, fmt.Errorf("número inválido: %q", number)
	}
	text := strconv.FormatFloat(parsed, 'f', -1, 64)
	if point := strings.IndexByte(text, '.'); point >= 0 {
		return len(text) - point - 1, nil
	}
	return 0, nil
}

func pow10(scale int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
}

func roundHalfAway(value *big.Rat) *big.Int {
	numerator := value.Num()
	denominator := value.Denom()
	quotient, remainder := new(big.Int).QuoRem(numerator, denominator, new(big.Int))
	doubled := new(big.Int).Abs(remainder)
	doubled.Lsh(doubled, 1)
	if doubled.Cmp(denominator) >= 0 {
		if numerator.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	return quotient
}
