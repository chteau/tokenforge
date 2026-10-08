package app

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// ConfigFromEnv reads configuration from environment variables:
//
//	TOKEN_SECRET (required), TOKEN_TTL (e.g. "12h"), FLAGS_FILE,
//	RATE_LIMIT_PER_MINUTE, RATE_LIMIT_BURST, TRUST_PROXY,
//	ADMIN_EMAIL, ADMIN_PASSWORD
func ConfigFromEnv(getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	cfg := Config{
		TokenSecret:            []byte(getenv("TOKEN_SECRET")),
		FlagsFile:              getenv("FLAGS_FILE"),
		BootstrapAdminEmail:    getenv("ADMIN_EMAIL"),
		BootstrapAdminPassword: getenv("ADMIN_PASSWORD"),
		RateLimitPerMinute:     120,
	}
	if len(cfg.TokenSecret) == 0 {
		return Config{}, ErrMissingSecret
	}
	if v := getenv("TOKEN_TTL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return Config{}, fmt.Errorf("TOKEN_TTL: invalid duration %q", v)
		}
		cfg.TokenTTL = d
	}
	for name, dst := range map[string]*int{"RATE_LIMIT_PER_MINUTE": &cfg.RateLimitPerMinute, "RATE_LIMIT_BURST": &cfg.RateLimitBurst} {
		if v := getenv(name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				return Config{}, fmt.Errorf("%s: invalid value %q", name, v)
			}
			*dst = n
		}
	}
	if v := getenv("TRUST_PROXY"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("TRUST_PROXY: invalid value %q", v)
		}
		cfg.TrustProxy = b
	}
	return cfg, nil
}
