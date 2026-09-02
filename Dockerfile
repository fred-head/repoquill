# syntax=docker/dockerfile:1
FROM node:24-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.26.7-alpine AS backend
ARG VERSION=0.1.0-alpha.2
WORKDIR /src
COPY go.mod go.sum ./
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/ web/
COPY --from=frontend /src/frontend/dist/ web/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/repoquill ./cmd/repoquill

FROM alpine:3.24
ARG VERSION=0.1.0-alpha.2
ARG VCS_REF=""
LABEL org.opencontainers.image.title="RepoQuill" \
      org.opencontainers.image.description="Self-hosted Git-backed Markdown notes" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/fred-head/repoquill" \
      org.opencontainers.image.url="https://github.com/fred-head/repoquill" \
      org.opencontainers.image.documentation="https://github.com/fred-head/repoquill/blob/main/README.md" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${VCS_REF}"
RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates git openssh-client \
    && addgroup -S repoquill \
    && adduser -S -G repoquill -h /data repoquill \
    && mkdir -p /data/app /data/repos /data/notebooks /data/keys \
    && touch /data/keys/known_hosts \
    && chmod 700 /data/keys \
    && chmod 600 /data/keys/known_hosts \
    && chown -R repoquill:repoquill /data
COPY --from=backend /out/repoquill /usr/local/bin/repoquill
COPY LICENSE /usr/share/licenses/repoquill/LICENSE
COPY THIRD-PARTY-NOTICES.md /usr/share/licenses/repoquill/THIRD-PARTY-NOTICES.md
USER repoquill
VOLUME ["/data"]
EXPOSE 8080
ENV REPOQUILL_ADDR=:8080
ENTRYPOINT ["/usr/local/bin/repoquill"]
