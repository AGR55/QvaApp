package marketmath

import (
	"strings"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func TestMedian(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   string
		ok     bool
	}{
		{"impar", []string{"1.03", "1.04", "8", "1.02", "1.05"}, "1.04000000", true},
		{"par", []string{"930", "910", "940", "920"}, "925.00000000", true},
		{"sin referencia", []string{"0", "-1"}, "", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			values := make([]decimal.Value, 0, len(test.values))
			for _, value := range test.values {
				values = append(values, decimal.MustParse(value))
			}
			got, ok := Median(values)
			if ok != test.ok {
				t.Fatalf("ok = %v, quiero %v", ok, test.ok)
			}
			if ok && got.Format(8) != test.want {
				t.Fatalf("mediana = %s, quiero %s", got.Format(8), test.want)
			}
		})
	}
}

func TestOutgoingFiatCost(t *testing.T) {
	cost := OutgoingFiatCost(decimal.MustParse("10"), decimal.MustParse("1.04"), decimal.MustParse("0.08"))
	if cost.Nominal.Format(8) != "10.40000000" ||
		cost.Fee.Format(8) != "0.08000000" ||
		cost.Total.Format(8) != "10.48000000" ||
		cost.EffectiveRate.Format(8) != "1.04800000" {
		t.Fatalf("coste inesperado: %+v", cost)
	}
	withoutFee := OutgoingFiatCost(decimal.MustParse("10"), decimal.MustParse("1.04"), decimal.Zero())
	if withoutFee.Total.Format(8) != "10.40000000" || withoutFee.EffectiveRate.Format(8) != "1.04000000" {
		t.Fatalf("coste sin comisión inesperado: %+v", withoutFee)
	}
}

func TestOwnOfferFiatTotal(t *testing.T) {
	cases := []struct {
		name     string
		qusd     string
		rate     string
		side     OfferType
		currency string
		want     string
		scale    int
	}{
		{"CUP compra redondea abajo", "9", "973.7", Buy, "CUP", "8760", 0},
		{"CUP compra exacta", "10", "920", Buy, "CUP", "9200", 0},
		{"CUP venta redondea arriba", "9", "973.7", Sell, "CUP", "8770", 0},
		{"CUP venta exacta", "10", "920", Sell, "CUP", "9200", 0},
		{"USD compra", "2", "1.06", Buy, "USD", "2.12000000", 8},
		{"USD venta", "3", "1.123456789", Sell, "USD", "3.37037037", 8},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := OwnOfferFiatTotal(
				decimal.MustParse(test.qusd),
				decimal.MustParse(test.rate),
				test.side,
				test.currency,
			)
			if err != nil {
				t.Fatalf("error inesperado: %v", err)
			}
			if got.Format(test.scale) != test.want {
				t.Fatalf("total = %s, quiero %s", got.Format(test.scale), test.want)
			}
		})
	}

	_, err := OwnOfferFiatTotal(decimal.MustParse("0.1"), decimal.MustParse("1.06"), Buy, "CUP")
	if err == nil || !strings.Contains(err.Error(), "total fiat") {
		t.Fatalf("se esperaba error de total fiat, llegó %v", err)
	}
}

func TestRoundRateForIndex(t *testing.T) {
	cases := []struct {
		name       string
		effective  string
		side       OfferType
		index      string
		indexPlace int
		want       string
	}{
		{"compra", "1.051", Buy, "1.06", 2, "1.06"},
		{"compra grande", "924.01", Buy, "925", 0, "925"},
		{"venta", "1.1249", Sell, "1.12", 2, "1.12"},
		{"venta grande", "1025.99", Sell, "1025", 0, "1025"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := RoundRateForIndex(
				decimal.MustParse(test.effective),
				test.side,
				decimal.MustParse(test.index),
				test.indexPlace,
			)
			if err != nil {
				t.Fatalf("error inesperado: %v", err)
			}
			if got.Format(test.indexPlace) != test.want {
				t.Fatalf("tasa = %s, quiero %s", got.Format(test.indexPlace), test.want)
			}
		})
	}
}

func TestRoundQusd(t *testing.T) {
	if got := RoundQusd(decimal.MustParse("1.234567891")).Format(8); got != "1.23456789" {
		t.Fatalf("roundQusd = %s", got)
	}
	if got := RoundQusd(decimal.MustParse("1.234567895")).Format(8); got != "1.23456790" {
		t.Fatalf("roundQusd mitad = %s", got)
	}
}
