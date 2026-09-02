.PHONY: build go-cache-dirs test vet test-race audit frontend release-check dev

GOCACHE ?= $(HOME)/.cache/go-build
GOMODCACHE ?= $(HOME)/go/pkg/mod
GOTMPDIR ?= $(HOME)/.cache/repoquill/go-tmp

export GOCACHE
export GOMODCACHE
export GOTMPDIR

build:
	docker compose build

go-cache-dirs:
	mkdir -p "$(GOCACHE)" "$(GOMODCACHE)" "$(GOTMPDIR)"

test: go-cache-dirs
	go test ./...

vet: go-cache-dirs
	go vet ./...

test-race: go-cache-dirs
	go test -race ./...

audit: go-cache-dirs
	govulncheck ./...
	cd frontend && npm audit

frontend:
	cd frontend && npm ci && npm run lint && npm test && npm run build

release-check: test vet test-race frontend audit
	docker compose config --quiet
	docker build --build-arg VERSION=0.1.0-alpha.1 --tag repoquill:release-check .
	./scripts/ci-container-check.sh repoquill:release-check 0.1.0-alpha.1

dev:
	./scripts/dev.sh
