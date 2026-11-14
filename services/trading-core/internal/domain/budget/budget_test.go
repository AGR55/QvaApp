package budget

import (
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func offer(uuid, amount, rate string, receive ...string) Offer {
	result := Offer{
		UUID:   uuid,
		Coin:   "BANK_CUP",
		Type:   "buy",
		Status: "open",
		Amount: decimal.MustParse(amount),
		Rate:   decimal.MustParse(rate),
	}
	if len(receive) > 0 {
		value := decimal.MustParse(receive[0])
		result.Receive = &value
	}
	return result
}

func TestProportionalPlanSplitsBudget(t *testing.T) {
	plan, err := ProportionalPlan(
		[]Offer{offer("a", "10", "1000"), offer("b", "20", "1000")},
		"BANK_CUP",
		decimal.MustParse("15000"),
		decimal.MustParse("1010"),
		decimal.Zero(),
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Available.Format(8) != "15000.00000000" ||
		plan.Committed.Format(8) != "30000.00000000" ||
		plan.Deficit.Format(8) != "15000.00000000" {
		t.Fatalf("plan inesperado: %+v", plan)
	}
	if len(plan.Adjustments) != 2 {
		t.Fatalf("ajustes = %d", len(plan.Adjustments))
	}
	first := plan.Adjustments[0]
	if first.UUID != "a" || first.ProposedQusd.Format(8) != "5.00000000" ||
		first.ProposedFiat.Format(8) != "5000.00000000" ||
		first.ReleasedFiat.Format(8) != "5000.00000000" || first.Action != "edit" {
		t.Fatalf("primer ajuste inesperado: %+v", first)
	}
}

func TestProportionalPlanInvalidRate(t *testing.T) {
	plan, err := ProportionalPlan(
		[]Offer{
			offer("a", "10", "1000"),
			offer("b", "20", "1000"),
			offer("bad", "10", "1000000000000000000"),
		},
		"BANK_CUP",
		decimal.MustParse("30000"),
		decimal.MustParse("1010"),
		decimal.Zero(),
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Invalid) != 1 || plan.Invalid[0] != "bad" {
		t.Fatalf("inválidas = %v", plan.Invalid)
	}
	if plan.Committed.Format(8) != "30000.00000000" || plan.Deficit.Format(8) != "0.00000000" {
		t.Fatalf("plan inesperado: %+v", plan)
	}
}

func TestProportionalPlanFixedFee(t *testing.T) {
	a := offer("a", "10", "1.04")
	a.Coin = "CLASICA"
	b := offer("b", "5", "1.03")
	b.Coin = "CLASICA"
	plan, err := ProportionalPlan(
		[]Offer{a, b},
		"CLASICA",
		decimal.MustParse("20"),
		decimal.MustParse("1.1"),
		decimal.MustParse("0.08"),
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Committed.Format(8) != "15.71000000" || plan.Deficit.Format(8) != "0.00000000" {
		t.Fatalf("plan inesperado: %+v", plan)
	}
	if len(plan.Adjustments) != 0 {
		t.Fatalf("ajustes = %d", len(plan.Adjustments))
	}
}

func TestProportionalPlanRemoteTotalAndCupRounding(t *testing.T) {
	remote := offer("cup-rounded", "10", "973.7", "9730")
	plan, err := ProportionalPlan(
		[]Offer{remote},
		"BANK_CUP",
		decimal.MustParse("9000"),
		decimal.MustParse("980"),
		decimal.Zero(),
		"CUP",
	)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Available.Format(0) != "9000" ||
		plan.Committed.Format(0) != "9730" ||
		plan.Deficit.Format(0) != "730" {
		t.Fatalf("plan inesperado: %+v", plan)
	}
	if len(plan.Adjustments) != 1 {
		t.Fatalf("ajustes = %d", len(plan.Adjustments))
	}
	adjustment := plan.Adjustments[0]
	if adjustment.ProposedQusd.Format(8) != "9.24000000" ||
		adjustment.ProposedFiat.Format(0) != "8990" ||
		adjustment.ReleasedFiat.Format(0) != "740" ||
		adjustment.Action != "edit" {
		t.Fatalf("ajuste inesperado: %+v", adjustment)
	}
}

func TestProportionalPlanCancelsUnderflow(t *testing.T) {
	remote := offer("cup-underflow", "10", "973.7", "9730")
	plan, err := ProportionalPlan(
		[]Offer{remote},
		"BANK_CUP",
		decimal.MustParse("10"),
		decimal.MustParse("980"),
		decimal.Zero(),
		"CUP",
	)
	if err != nil {
		t.Fatal(err)
	}
	adjustment := plan.Adjustments[0]
	if adjustment.ProposedQusd.Sign() != 0 ||
		adjustment.ProposedFiat.Format(0) != "0" ||
		adjustment.ReleasedFiat.Format(0) != "9730" ||
		adjustment.Action != "cancel" {
		t.Fatalf("ajuste inesperado: %+v", adjustment)
	}
}

func TestProportionalPlanCancelsBelowQvaPayMinimum(t *testing.T) {
	remote := offer("cup-below-qvapay-minimum", "1", "1000", "1000")
	plan, err := ProportionalPlan(
		[]Offer{remote},
		"BANK_CUP",
		decimal.MustParse("90"),
		decimal.MustParse("1010"),
		decimal.Zero(),
		"CUP",
	)
	if err != nil {
		t.Fatal(err)
	}
	adjustment := plan.Adjustments[0]
	if adjustment.ProposedQusd.Sign() != 0 || adjustment.Action != "cancel" {
		t.Fatalf("ajuste inesperado: %+v", adjustment)
	}
}
