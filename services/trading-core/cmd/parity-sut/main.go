// Comando de conformidad v1 para el runner de paridad.
//
// Protocolo NDJSON por stdin/stdout, una petición y una respuesta por línea:
//
//	-> {"id":"case-1","op":"market.roundQusd","input":{"value":1.234567891}}
//	<- {"id":"case-1","result":{"value":"1.23456789"}}
//
// No usa red, reloj ni estado entre peticiones. Los importes viajan como
// strings decimales de escala fija; el CLI no expone float64.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/marketmath"
)

type request struct {
	ID    string          `json:"id"`
	Op    string          `json:"op"`
	Input json.RawMessage `json:"input"`
}

type opError struct {
	Class   string `json:"class"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

type response struct {
	ID     string   `json:"id"`
	Result any      `json:"result,omitempty"`
	Error  *opError `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = encoder.Encode(response{
				ID:    "<unparsed>",
				Error: &opError{Class: "protocol", Message: err.Error()},
			})
			continue
		}
		result, failure := dispatch(req)
		if failure != nil {
			_ = encoder.Encode(response{ID: req.ID, Error: failure})
			continue
		}
		_ = encoder.Encode(response{ID: req.ID, Result: result})
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "parity-sut: %v\n", err)
		os.Exit(2)
	}
}

func dispatch(req request) (any, *opError) {
	switch req.Op {
	case "market.roundQusd":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		value, _, failure := numberField(fields, "value")
		if failure != nil {
			return nil, failure
		}
		return map[string]any{"value": marketmath.RoundQusd(value).Format(8)}, nil

	case "market.median":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		values, failure := numberArrayField(fields, "values")
		if failure != nil {
			return nil, failure
		}
		median, ok := marketmath.Median(values)
		if !ok {
			return map[string]any{"value": nil}, nil
		}
		return map[string]any{"value": median.Format(8)}, nil

	case "market.outgoingFiatCost":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		qusdAmount, _, failure := numberField(fields, "qusdAmount")
		if failure != nil {
			return nil, failure
		}
		fiatPerQusd, _, failure := numberField(fields, "fiatPerQusd")
		if failure != nil {
			return nil, failure
		}
		fixedFee, _, failure := numberField(fields, "fixedFee")
		if failure != nil {
			return nil, failure
		}
		cost := marketmath.OutgoingFiatCost(qusdAmount, fiatPerQusd, fixedFee)
		return map[string]any{
			"nominal":       cost.Nominal.Format(8),
			"fee":           cost.Fee.Format(8),
			"total":         cost.Total.Format(8),
			"effectiveRate": cost.EffectiveRate.Format(8),
		}, nil

	case "market.ownOfferFiatTotal":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		qusdAmount, _, failure := numberField(fields, "qusdAmount")
		if failure != nil {
			return nil, failure
		}
		fiatPerQusd, _, failure := numberField(fields, "fiatPerQusd")
		if failure != nil {
			return nil, failure
		}
		side, failure := offerTypeField(fields, "type")
		if failure != nil {
			return nil, failure
		}
		currency, failure := stringField(fields, "currency")
		if failure != nil {
			return nil, failure
		}
		value, err := marketmath.OwnOfferFiatTotal(qusdAmount, fiatPerQusd, side, currency)
		if err != nil {
			return nil, validation(err.Error())
		}
		scale := 8
		if strings.EqualFold(strings.TrimSpace(currency), "CUP") {
			scale = 0
		}
		return map[string]any{"value": value.Format(scale)}, nil

	case "market.roundRateForIndex":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		effectiveRate, _, failure := numberField(fields, "effectiveRate")
		if failure != nil {
			return nil, failure
		}
		side, failure := offerTypeField(fields, "type")
		if failure != nil {
			return nil, failure
		}
		configuredIndex, indexText, failure := numberField(fields, "configuredIndex")
		if failure != nil {
			return nil, failure
		}
		places, err := decimal.Places(indexText)
		if err != nil {
			return nil, validation(err.Error())
		}
		value, err := marketmath.RoundRateForIndex(effectiveRate, side, configuredIndex, places)
		if err != nil {
			return nil, validation(err.Error())
		}
		return map[string]any{"value": value.Format(places)}, nil

	default:
		return nil, &opError{
			Class:   "protocol",
			Code:    "unknown-op",
			Message: fmt.Sprintf("Operación desconocida: %s", req.Op),
		}
	}
}

func object(raw json.RawMessage) (map[string]any, *opError) {
	value, err := decode(raw)
	if err != nil {
		return nil, protocol(err.Error())
	}
	fields, ok := value.(map[string]any)
	if !ok {
		return nil, validation("El input debe ser un objeto.")
	}
	return fields, nil
}

func numberField(fields map[string]any, key string) (decimal.Value, string, *opError) {
	value, ok := fields[key]
	if !ok {
		return decimal.Value{}, "", validation(fmt.Sprintf("El campo %s debe ser un número finito.", key))
	}
	number, ok := value.(json.Number)
	if !ok {
		return decimal.Value{}, "", validation(fmt.Sprintf("El campo %s debe ser un número finito.", key))
	}
	parsed, err := decimal.Parse(number.String())
	if err != nil {
		return decimal.Value{}, "", validation(fmt.Sprintf("El campo %s debe ser un número finito.", key))
	}
	return parsed, number.String(), nil
}

func numberArrayField(fields map[string]any, key string) ([]decimal.Value, *opError) {
	value, ok := fields[key]
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	items, ok := value.([]any)
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	values := make([]decimal.Value, 0, len(items))
	for _, item := range items {
		number, ok := item.(json.Number)
		if !ok {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de números.", key))
		}
		parsed, err := decimal.Parse(number.String())
		if err != nil {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de números.", key))
		}
		values = append(values, parsed)
	}
	return values, nil
}

func stringField(fields map[string]any, key string) (string, *opError) {
	value, ok := fields[key]
	if !ok {
		return "", validation(fmt.Sprintf("El campo %s debe ser texto.", key))
	}
	text, ok := value.(string)
	if !ok {
		return "", validation(fmt.Sprintf("El campo %s debe ser texto.", key))
	}
	return text, nil
}

func offerTypeField(fields map[string]any, key string) (marketmath.OfferType, *opError) {
	text, failure := stringField(fields, key)
	if failure != nil {
		return "", failure
	}
	side, err := marketmath.ParseOfferType(text)
	if err != nil {
		return "", validation("El tipo debe ser buy o sell.")
	}
	return side, nil
}

func decode(raw json.RawMessage) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, fmt.Errorf("input vacío")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func validation(message string) *opError {
	return &opError{Class: "validation", Message: message}
}

func protocol(message string) *opError {
	return &opError{Class: "protocol", Message: message}
}
