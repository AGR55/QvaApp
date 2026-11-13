package marketmath

import (
	"testing"
	"testing/quick"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func TestRoundQusdIsIdempotent(t *testing.T) {
	property := func(units int64) bool {
		value, err := decimal.FromInt(units).Div(decimal.FromInt(100_000_000))
		if err != nil {
			return false
		}
		rounded := RoundQusd(value)
		if rounded.Cmp(RoundQusd(rounded)) != 0 {
			return false
		}
		parsed, err := decimal.Parse(rounded.Format(8))
		return err == nil && parsed.Cmp(rounded) == 0
	}
	if err := quick.Check(property, &quick.Config{MaxCount: 1_000}); err != nil {
		t.Fatal(err)
	}
}

func TestCupTotalIsAlwaysMultipleOfTen(t *testing.T) {
	property := func(amountUnits uint16, rateUnits uint32) bool {
		amount, err := decimal.FromInt(int64(amountUnits % 1_000)).Div(decimal.FromInt(100))
		if err != nil {
			return false
		}
		rate, err := decimal.FromInt(int64(rateUnits % 100_000)).Div(decimal.FromInt(100))
		if err != nil {
			return false
		}
		total, err := OwnOfferFiatTotal(amount, rate, Buy, "CUP")
		if err != nil {
			return true
		}
		tens, err := total.Div(decimal.FromInt(10))
		if err != nil {
			return false
		}
		if _, integral := tens.Int64(); !integral {
			return false
		}
		return total.Cmp(decimal.MustParse("0.1")) >= 0
	}
	if err := quick.Check(property, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}
