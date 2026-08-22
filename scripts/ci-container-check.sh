#!/usr/bin/env bash

set -Eeuo pipefail

image="${1:-}"
expected_version="${2:-}"
if [[ -z "${image}" || -z "${expected_version}" ]]; then
  echo "Usage: $0 <image> <expected-version>" >&2
  exit 2
fi

check_id="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
if [[ ! "${check_id}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Unsafe release-check identifier" >&2
  exit 2
fi

container_name="repoquill-check-${check_id}"
volume_name="repoquill-check-${check_id}"
container_created=false
volume_created=false

cleanup() {
  trap - EXIT INT TERM
  if [[ "${container_created}" == true ]]; then
    docker rm --force "${container_name}" >/dev/null 2>&1 || true
  fi
  if [[ "${volume_created}" == true ]]; then
    docker volume rm "${volume_name}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if docker container inspect "${container_name}" >/dev/null 2>&1 || docker volume inspect "${volume_name}" >/dev/null 2>&1; then
  echo "Refusing to reuse an existing release-check container or volume" >&2
  exit 1
fi

configured_user="$(docker image inspect --format '{{.Config.User}}' "${image}")"
if [[ -z "${configured_user}" || "${configured_user}" == "0" || "${configured_user}" == "root" ]]; then
  echo "Image does not configure a non-root user" >&2
  exit 1
fi

docker volume create "${volume_name}" >/dev/null
volume_created=true

start_container() {
  docker run --detach \
    --name "${container_name}" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --publish 127.0.0.1::8080 \
    --volume "${volume_name}:/data" \
    --env REPOQUILL_REPOSITORY=/data/repos \
    --env REPOQUILL_NOTEBOOKS_DIR=/data/notebooks \
    --env REPOQUILL_NOTEBOOK_METADATA=/data/app/notebooks.json \
    --env REPOQUILL_KEYS_DIR=/data/keys \
    --env REPOQUILL_SSH_KNOWN_HOSTS=/data/keys/known_hosts \
    "${image}" >/dev/null
  container_created=true
}

wait_for_health() {
  local port response
  port="$(docker port "${container_name}" 8080/tcp | sed -n 's/.*://p' | head -n 1)"
  if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
    echo "Could not determine published health-check port" >&2
    exit 1
  fi
  for _ in {1..30}; do
    if response="$(curl --fail --silent --show-error "http://127.0.0.1:${port}/api/health" 2>/dev/null)"; then
      if [[ "${response}" != *'"status":"ok"'* || "${response}" != *"\"version\":\"${expected_version}\""* ]]; then
        echo "Unexpected health response: ${response}" >&2
        exit 1
      fi
      printf '%s\n' "${port}"
      return
    fi
    sleep 1
  done
  docker logs "${container_name}" >&2 || true
  echo "Container did not become healthy" >&2
  exit 1
}

start_container
port="$(wait_for_health)"

runtime_uid="$(docker exec "${container_name}" id -u)"
if [[ "${runtime_uid}" == "0" ]]; then
  echo "Container process is running as root" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"path":"Release check.md","type":"file"}' \
  "http://127.0.0.1:${port}/api/repository/entries" >/dev/null

docker rm --force "${container_name}" >/dev/null
container_created=false

start_container
port="$(wait_for_health)"
curl --fail --silent --show-error \
  "http://127.0.0.1:${port}/api/repository/file?path=Release%20check.md" \
  | grep --fixed-strings '"path":"Release check.md"' >/dev/null

docker rm --force "${container_name}" >/dev/null
container_created=false

docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --volume "${volume_name}:/data:ro" \
  --entrypoint /bin/sh \
  "${image}" \
  -c 'test -f "/data/repos/Release check.md" && test ! -s "/data/repos/Release check.md"'

echo "Container security, health, and persistence checks passed."
