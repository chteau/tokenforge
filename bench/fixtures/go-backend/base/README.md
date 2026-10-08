# Meridian

Subscription billing API: accounts, plans, invoices and payments.

```sh
TOKEN_SECRET=$(openssl rand -hex 32) ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=change-me-now \
  go run ./cmd/server
```

Configuration is read from the environment, see `internal/app/env.go`.

```sh
go test ./...
go vet ./...
gofmt -l .
```

See `docs/architecture.md` for the code layout and conventions and
`docs/api.md` for the endpoint reference.
