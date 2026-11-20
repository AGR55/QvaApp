package riskpolicy

import (
	"strings"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func baseContext() Context {
	must := decimal.MustParse
	return Context{
		Now: must("1788696000000"),
		Opportunity: Opportunity{
			UUID:          "offer-1",
			Market:        "BANK_CUP",
			Side:          SellQusd,
			QusdAmount:    must("20"),
			RequiredFiat:  must("20000"),
			QuotedRate:    must("1010"),
			ReferenceRate: must("1005"),
			ObservedAt:    must("1788695995000"),
		},
		Limits: Limits{
			MaxQusdPerOperation:         must("25"),
			MaxConcurrentQusdExposure:   must("50"),
			MaxDailyAppliedQusd:         must("100"),
			MaxConcurrentOperations:     must("2"),
			MinQusdReserve:              must("10"),
			MaxQuoteAgeSeconds:          must("45"),
			MinExpectedMarginPercent:    must("0.5"),
			MaxSlippagePercent:          must("1"),
			MaxConsecutiveErrors:        must("3"),
			MarketCooldownSeconds:       must("30"),
			CounterpartyCooldownSeconds: must("300"),
		},
		PriceDecision:          Eligible,
		PriceReason:            "Supera el mínimo de venta.",
		ExpectedMarginPercent:  must("2"),
		QusdBalance:            must("100"),
		FiatAvailable:          must("100000"),
		ConcurrentQusdExposure: must("5"),
		DailyAppliedQusd:       must("20"),
		ActiveOperations:       must("1"),
		ConsecutiveErrors:      must("0"),
	}
}

func TestEvaluateApply(t *testing.T) {
	decision, err := Evaluate(baseContext())
	if err != nil {
		t.Fatal(err)
	}
	if decision.Kind != Apply {
		t.Fatalf("kind = %s", decision.Kind)
	}
	if len(decision.Checks) != 15 {
		t.Fatalf("checks = %d", len(decision.Checks))
	}
	if decision.Checks[0].Code != "price_policy" || decision.Checks[14].Code != "qusd_capital" {
		t.Fatalf("orden de checks inesperado: %s ... %s", decision.Checks[0].Code, decision.Checks[14].Code)
	}
	if decision.RequiredQusd.Format(8) != "20.00000000" ||
		decision.RequiredFiat.Sign() != 0 ||
		decision.ProjectedExposureQusd.Format(8) != "25.00000000" {
		t.Fatalf("importes inesperados: %+v", decision)
	}
}

func TestEvaluateBlocksFailures(t *testing.T) {
	context := baseContext()
	context.EmergencyStop = true
	context.HasUnresolvedMutation = true
	context.QusdBalance = decimal.MustParse("25")
	decision, err := Evaluate(context)
	if err != nil {
		t.Fatal(err)
	}
	if decision.Kind != Blocked {
		t.Fatalf("kind = %s", decision.Kind)
	}
	if len(decision.Reasons) != 3 {
		t.Fatalf("reasons = %v", decision.Reasons)
	}
	if !strings.Contains(decision.Reasons[0], "interruptor") {
		t.Fatalf("primera razón = %q", decision.Reasons[0])
	}
}

func TestEvaluateRejectsNegativeContext(t *testing.T) {
	context := baseContext()
	context.DailyAppliedQusd = decimal.MustParse("-1")
	_, err := Evaluate(context)
	if err == nil || !strings.Contains(err.Error(), "finitos y no negativos") {
		t.Fatalf("error = %v", err)
	}
}
