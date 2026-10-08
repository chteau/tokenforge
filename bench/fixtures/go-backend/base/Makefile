.PHONY: build test vet fmt check run

build:
	go build -o bin/server ./cmd/server

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

check: vet test
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

run:
	go run ./cmd/server
