package decimal

import "testing"

func TestFormatFixedScale(t *testing.T) {
	cases := []struct {
		input string
		scale int
		want  string
	}{
		{"1.234567891", 8, "1.23456789"},
		{"1.234567895", 8, "1.23456790"},
		{"10.4", 8, "10.40000000"},
		{"8760", 0, "8760"},
		{"2.12", 8, "2.12000000"},
		{"-1.5", 2, "-1.50"},
	}
	for _, test := range cases {
		got := MustParse(test.input).Format(test.scale)
		if got != test.want {
			t.Fatalf("Format(%s, %d) = %q, quiero %q", test.input, test.scale, got, test.want)
		}
	}
}

func TestRoundAndIntegralOps(t *testing.T) {
	if got := MustParse("0.0106").Round(0).Format(0); got != "0" {
		t.Fatalf("Round(0) = %q", got)
	}
	if got := MustParse("2.5").Round(0).Format(0); got != "3" {
		t.Fatalf("mitad positiva = %q", got)
	}
	if got := MustParse("0.0106").Floor().Format(0); got != "0" {
		t.Fatalf("Floor = %q", got)
	}
	if got := MustParse("0.0106").Ceil().Format(0); got != "1" {
		t.Fatalf("Ceil = %q", got)
	}
	if got := MustParse("1025.99").Ceil().Format(0); got != "1026" {
		t.Fatalf("Ceil grande = %q", got)
	}
}

func TestCompact(t *testing.T) {
	cases := map[string]string{
		"30":           "30",
		"30.00000000":  "30",
		"41.37000000":  "41.37",
		"106.51000000": "106.51",
		"0":            "0",
	}
	for input, want := range cases {
		if got := MustParse(input).Compact(); got != want {
			t.Fatalf("Compact(%s) = %q, quiero %q", input, got, want)
		}
	}
}

func TestPlaces(t *testing.T) {
	cases := map[string]int{
		"1.06":     2,
		"925":      0,
		"1.12":     2,
		"1025":     0,
		"973.7":    1,
		"1e-7":     7,
		"1.2300e2": 0,
	}
	for input, want := range cases {
		got, err := Places(input)
		if err != nil {
			t.Fatalf("Places(%s): %v", input, err)
		}
		if got != want {
			t.Fatalf("Places(%s) = %d, quiero %d", input, got, want)
		}
	}
}
