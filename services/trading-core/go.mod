module github.com/AGR55/QvaApp/services/trading-core

go 1.27

require (
	github.com/AGR55/QvaApp/services/shared v0.0.0
	github.com/SherClockHolmes/webpush-go v1.4.0
	github.com/jackc/pgx/v5 v5.13.0
)

require (
	github.com/golang-jwt/jwt/v5 v5.2.1 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/text v0.41.0 // indirect
)

replace github.com/AGR55/QvaApp/services/shared => ../shared
