package budget

import (
	"testing"
	"testing/quick"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func TestProportionalPlanNeverExceedsAvailable(t *testing.T) {
	property := func(amountA, amountB, feeUnits uint16, availableUnits uint32) bool {
		first := offer("a", decimal.FromInt(int64(amountA%2_000)).Format(0), "1000")
		second := offer("b", decimal.FromInt(int64(amountB%2_000)).Format(0), "1000")
		fee := decimal.FromInt(int64(feeUnits % 100))
		available := decimal.FromInt(int64(availableUnits % 50_000))
		plan, err := ProportionalPlan(
			[]Offer{first, second},
			"BANK_CUP",
			available,
			decimal.FromInt(1010),
			fee,
			"",
		)
		if err != nil {
			return false
		}
		safeAvailable := available
		if available.Sign() < 0 {
			safeAvailable = decimal.Zero()
		}
		if plan.Available.Cmp(safeAvailable) != 0 {
			return false
		}
		proposed := decimal.Zero()
		for _, adjustment := range plan.Adjustments {
			if adjustment.ProposedQusd.Cmp(adjustment.CurrentQusd) > 0 ||
				adjustment.ProposedFiat.Cmp(adjustment.CurrentFiat) > 0 {
				return false
			}
			proposed = proposed.Add(adjustment.ProposedFiat)
		}
		if len(plan.Adjustments) > 0 && proposed.Cmp(safeAvailable) > 0 {
			return false
		}
		return plan.Deficit.Cmp(decimal.Zero()) >= 0
	}
	if err := quick.Check(property, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}
