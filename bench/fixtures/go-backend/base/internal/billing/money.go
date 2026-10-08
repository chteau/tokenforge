// Package billing contains the billing domain model: plans, subscriptions,
// invoices and payments. All monetary amounts are int64 minor units (cents).
package billing

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ErrInvalidAmount is returned by ParseAmount for malformed input.
var ErrInvalidAmount = errors.New("billing: invalid amount")

var currencySymbols = map[string]string{"EUR": "€", "USD": "$", "GBP": "£"}

// FormatCents renders an amount for humans, e.g. FormatCents(123456, "EUR") == "€1,234.56".
func FormatCents(cents int64, currency string) string {
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	whole := strconv.FormatInt(cents/100, 10)
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if sym, ok := currencySymbols[currency]; ok {
		return fmt.Sprintf("%s%s%s.%02d", sign, sym, b.String(), cents%100)
	}
	return fmt.Sprintf("%s%s.%02d %s", sign, b.String(), cents%100, currency)
}

// ParseAmount parses a decimal string such as "12.5" or "1200" into cents.
func ParseAmount(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "-") || strings.HasPrefix(s, "+") {
		return 0, ErrInvalidAmount
	}
	whole, frac, hasFrac := strings.Cut(s, ".")
	if whole == "" || (hasFrac && (frac == "" || len(frac) > 2)) {
		return 0, ErrInvalidAmount
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || w > (1<<62)/100 {
		return 0, ErrInvalidAmount
	}
	var f int64
	if hasFrac {
		if len(frac) == 1 {
			frac += "0"
		}
		f, err = strconv.ParseInt(frac, 10, 64)
		if err != nil {
			return 0, ErrInvalidAmount
		}
	}
	return w*100 + f, nil
}

// ApplyBasisPoints returns cents * bps / 10000 rounded half away from zero.
// 2000 basis points is 20%.
func ApplyBasisPoints(cents, bps int64) int64 {
	p := cents * bps
	q, r := p/10000, p%10000
	if r >= 5000 {
		q++
	} else if r <= -5000 {
		q--
	}
	return q
}
