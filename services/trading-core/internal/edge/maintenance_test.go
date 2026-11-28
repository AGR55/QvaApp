package edge

import (
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func TestNextOfferToRefresh(t *testing.T) {
	now := time.Date(2026, 11, 15, 20, 0, 0, 0, time.UTC)
	offers := []qvapay.Offer{
		{UUID: "fresh", Status: "open", UpdatedAt: now.Add(-time.Minute).Format(time.RFC3339)},
		{UUID: "old", Status: "open", UpdatedAt: now.Add(-10 * time.Minute).Format(time.RFC3339)},
		{UUID: "mid", Status: "open", UpdatedAt: now.Add(-5 * time.Minute).Format(time.RFC3339)},
		{UUID: "closed", Status: "cancelled", UpdatedAt: now.Add(-time.Hour).Format(time.RFC3339)},
	}
	next, ok := NextOfferToRefresh(offers, now, 4*time.Minute, 10*time.Second, time.Time{})
	if !ok || next.UUID != "old" {
		t.Fatalf("next = %+v ok=%v", next, ok)
	}
	if _, ok := NextOfferToRefresh(offers, now, 4*time.Minute, 10*time.Second, now.Add(-5*time.Second)); ok {
		t.Fatal("el espaciado debe bloquear el refresco")
	}
	if _, ok := NextOfferToRefresh(offers[:1], now, 4*time.Minute, 10*time.Second, time.Time{}); ok {
		t.Fatal("una oferta fresca no debe refrescarse")
	}
}

func TestDueForCancel(t *testing.T) {
	now := time.Date(2026, 11, 15, 20, 0, 0, 0, time.UTC)
	operations := []PendingOperation{
		{UUID: "old", State: "applied", CreatedAt: now.Add(-2 * time.Hour).UnixMilli()},
		{UUID: "new", State: "applied", CreatedAt: now.Add(-10 * time.Minute).UnixMilli()},
		{UUID: "paid", State: "paid", CreatedAt: now.Add(-2 * time.Hour).UnixMilli()},
	}
	due := DueForCancel(operations, now, time.Hour)
	if len(due) != 1 || due[0].UUID != "old" {
		t.Fatalf("due = %+v", due)
	}
}

func TestShouldAutoCancel(t *testing.T) {
	if !ShouldAutoCancel("processing", "") {
		t.Fatal("processing debe cancelarse")
	}
	if ShouldAutoCancel("paid", "") {
		t.Fatal("paid no debe cancelarse")
	}
	if ShouldAutoCancel("completed", "completed") {
		t.Fatal("completed no debe cancelarse")
	}
	if !ShouldAutoCancel("processing", "processing") {
		t.Fatal("la orden processing debe cancelarse")
	}
}
