package edge

import (
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

// NextOfferToRefresh elige la oferta propia que toca refrescar. Mantiene el
// espaciado global y prioriza la más antigua.
func NextOfferToRefresh(
	offers []qvapay.Offer,
	now time.Time,
	interval, spacing time.Duration,
	lastEdit time.Time,
) (qvapay.Offer, bool) {
	if interval <= 0 {
		return qvapay.Offer{}, false
	}
	if !lastEdit.IsZero() && now.Sub(lastEdit) < spacing {
		return qvapay.Offer{}, false
	}
	var selected qvapay.Offer
	var selectedAt time.Time
	for _, offer := range offers {
		if offer.UUID == "" {
			continue
		}
		if offer.Status != "" && strings.ToLower(offer.Status) != "open" {
			continue
		}
		updated := parseOfferTimestamp(offer.UpdatedAt)
		if !updated.IsZero() && now.Sub(updated) < interval {
			continue
		}
		if selected.UUID == "" || updated.Before(selectedAt) {
			selected = offer
			selectedAt = updated
		}
	}
	return selected, selected.UUID != ""
}

// parseOfferTimestamp acepta RFC3339 y epoch en segundos o milisegundos.
func parseOfferTimestamp(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed
	}
	if number, err := strconv.ParseInt(value, 10, 64); err == nil {
		if number < 1_000_000_000_000 {
			number *= 1000
		}
		return time.UnixMilli(number)
	}
	return time.Time{}
}
