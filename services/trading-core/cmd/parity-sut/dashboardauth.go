package main

import (
	"errors"
	"regexp"
	"strconv"
	"strings"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/dashboardauth"
)

var maxAgePattern = regexp.MustCompile(`Max-Age=(\d+)`)

func authErrorStatus(err error) any {
	var authErr *dashboardauth.Error
	if errors.As(err, &authErr) {
		return authErr.Status
	}
	return nil
}

func authCookieFlags(cookie string) map[string]any {
	maxAge := int64(-1)
	if match := maxAgePattern.FindStringSubmatch(cookie); len(match) == 2 {
		if parsed, err := strconv.ParseInt(match[1], 10, 64); err == nil {
			maxAge = parsed
		}
	}
	return map[string]any{
		"httpOnly":       strings.Contains(cookie, "HttpOnly"),
		"sameSiteStrict": strings.Contains(cookie, "SameSite=Strict"),
		"maxAge":         maxAge,
	}
}

func authNumber(fields map[string]any, key string, fallback int64) (int64, *opError) {
	if fields[key] == nil {
		return fallback, nil
	}
	return integerField(fields, key)
}

func authOrigins(fields map[string]any) ([]any, *opError) {
	raw, ok := fields["origins"].([]any)
	if !ok {
		return nil, validation("El campo origins debe ser un array.")
	}
	return raw, nil
}

func authLogin(fields map[string]any) (any, *opError) {
	password, failure := stringField(fields, "password")
	if failure != nil {
		return nil, failure
	}
	trustedOrigin, failure := stringField(fields, "trustedOrigin")
	if failure != nil {
		return nil, failure
	}
	now, failure := authNumber(fields, "now", 1_000)
	if failure != nil {
		return nil, failure
	}
	var duration *int64
	if fields["sessionDurationMs"] != nil {
		value, failure := integerField(fields, "sessionDurationMs")
		if failure != nil {
			return nil, failure
		}
		duration = &value
	}
	options := dashboardauth.Options{
		Password:      password,
		TrustedOrigin: trustedOrigin,
		Now:           func() int64 { return now },
		CreateToken:   func() string { return "token" },
		CreateCSRF:    func() string { return "csrf" },
	}
	if duration != nil {
		options.SessionDurationMs = *duration
	}
	auth, err := dashboardauth.New(options)
	if err != nil {
		return nil, validation(err.Error())
	}
	loginPassword, failure := stringField(fields, "loginPassword")
	if failure != nil {
		return nil, failure
	}
	clientID, failure := stringField(fields, "clientId")
	if failure != nil {
		return nil, failure
	}
	cookie, csrfToken, expiresAt, err := auth.Login(loginPassword, clientID)
	if err != nil {
		return nil, validation(err.Error())
	}
	csrfAccepted := auth.AssertCSRF(cookie, csrfToken) == nil
	wrongStatus := authErrorStatus(auth.AssertCSRF(cookie, "otro"))
	result := authCookieFlags(cookie)
	result["expiresAt"] = expiresAt
	result["csrfAccepted"] = csrfAccepted
	result["wrongCsrfStatus"] = wrongStatus
	return result, nil
}

func authOriginsResult(fields map[string]any) (any, *opError) {
	password, failure := stringField(fields, "password")
	if failure != nil {
		return nil, failure
	}
	trustedOrigin, failure := stringField(fields, "trustedOrigin")
	if failure != nil {
		return nil, failure
	}
	now, failure := authNumber(fields, "now", 1_000)
	if failure != nil {
		return nil, failure
	}
	origins, failure := authOrigins(fields)
	if failure != nil {
		return nil, failure
	}
	auth, err := dashboardauth.New(dashboardauth.Options{Password: password, TrustedOrigin: trustedOrigin, Now: func() int64 { return now }})
	if err != nil {
		return nil, validation(err.Error())
	}
	results := make([]any, 0, len(origins))
	for _, origin := range origins {
		value := ""
		if text, ok := origin.(string); ok {
			value = text
		}
		if err := auth.AssertOrigin(value); err != nil {
			results = append(results, map[string]any{"ok": false, "status": authErrorStatus(err)})
		} else {
			results = append(results, map[string]any{"ok": true})
		}
	}
	return map[string]any{"results": results}, nil
}

func authOriginsRateLimit(fields map[string]any) (any, *opError) {
	password, failure := stringField(fields, "password")
	if failure != nil {
		return nil, failure
	}
	trustedOrigin, failure := stringField(fields, "trustedOrigin")
	if failure != nil {
		return nil, failure
	}
	now, failure := authNumber(fields, "now", 0)
	if failure != nil {
		return nil, failure
	}
	origins, failure := authOrigins(fields)
	if failure != nil {
		return nil, failure
	}
	auth, err := dashboardauth.New(dashboardauth.Options{Password: password, TrustedOrigin: trustedOrigin, Now: func() int64 { return now }})
	if err != nil {
		return nil, validation(err.Error())
	}
	originResults := make([]any, 0, len(origins))
	for _, origin := range origins {
		value := ""
		if text, ok := origin.(string); ok {
			value = text
		}
		if err := auth.AssertOrigin(value); err != nil {
			originResults = append(originResults, map[string]any{"ok": false, "status": authErrorStatus(err)})
		} else {
			originResults = append(originResults, map[string]any{"ok": true})
		}
	}
	clientID, failure := stringField(fields, "clientId")
	if failure != nil {
		return nil, failure
	}
	failed, failure := integerField(fields, "failed")
	if failure != nil {
		return nil, failure
	}
	failedStatuses := make([]any, 0, failed)
	for attempt := int64(0); attempt < failed; attempt++ {
		if _, _, _, err := auth.Login("incorrecta", clientID); err != nil {
			if status := authErrorStatus(err); status != nil {
				failedStatuses = append(failedStatuses, status)
			}
		}
	}
	finalStatus := any(nil)
	if _, _, _, err := auth.Login(password, clientID); err != nil {
		finalStatus = authErrorStatus(err)
	}
	return map[string]any{"origins": originResults, "failedStatuses": failedStatuses, "finalStatus": finalStatus}, nil
}

func authRateLimit(fields map[string]any) (any, *opError) {
	password, failure := stringField(fields, "password")
	if failure != nil {
		return nil, failure
	}
	trustedOrigin, failure := stringField(fields, "trustedOrigin")
	if failure != nil {
		return nil, failure
	}
	now, failure := authNumber(fields, "now", 0)
	if failure != nil {
		return nil, failure
	}
	auth, err := dashboardauth.New(dashboardauth.Options{Password: password, TrustedOrigin: trustedOrigin, Now: func() int64 { return now }})
	if err != nil {
		return nil, validation(err.Error())
	}
	clientID, failure := stringField(fields, "clientId")
	if failure != nil {
		return nil, failure
	}
	failed, failure := integerField(fields, "failed")
	if failure != nil {
		return nil, failure
	}
	statuses := make([]any, 0, failed)
	for attempt := int64(0); attempt < failed; attempt++ {
		if _, _, _, err := auth.Login("incorrecta", clientID); err != nil {
			if status := authErrorStatus(err); status != nil {
				statuses = append(statuses, status)
			}
		}
	}
	finalStatus := any(nil)
	if _, _, _, err := auth.Login(password, clientID); err != nil {
		finalStatus = authErrorStatus(err)
	}
	return map[string]any{"failedStatuses": statuses, "finalStatus": finalStatus}, nil
}

func authSessionResult(fields map[string]any) (any, *opError) {
	password, failure := stringField(fields, "password")
	if failure != nil {
		return nil, failure
	}
	trustedOrigin, failure := stringField(fields, "trustedOrigin")
	if failure != nil {
		return nil, failure
	}
	now, failure := authNumber(fields, "now", 0)
	if failure != nil {
		return nil, failure
	}
	duration, failure := integerField(fields, "sessionDurationMs")
	if failure != nil {
		return nil, failure
	}
	auth, err := dashboardauth.New(dashboardauth.Options{
		Password:          password,
		TrustedOrigin:     trustedOrigin,
		Now:               func() int64 { return now },
		SessionDurationMs: duration,
	})
	if err != nil {
		return nil, validation(err.Error())
	}
	cookie, _, _, err := auth.Login(password, "local")
	if err != nil {
		return nil, validation(err.Error())
	}
	before := auth.SessionValid(cookie)
	advance, failure := integerField(fields, "advance")
	if failure != nil {
		return nil, failure
	}
	now += advance
	after := auth.SessionValid(cookie)
	return map[string]any{"before": before, "after": after}, nil
}
