.PHONY: build test test-race audit frontend release-check dev

build:
	docker compose build

test:
	go test ./...

test-race:
	go test -race ./...

audit:
	govulncheck ./...
	cd frontend && npm audit

frontend:
	cd frontend && npm ci && npm run lint && npm test && npm run build

release-check: test test-race frontend audit
	docker compose config --quiet
	docker build --build-arg VERSION=0.1.0-alpha.1 --tag repoquill:release-check .
	./scripts/ci-container-check.sh repoquill:release-check 0.1.0-alpha.1

dev:
	./scripts/dev.sh
