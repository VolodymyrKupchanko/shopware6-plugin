#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCEPTANCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE=(docker compose --project-name paynl-sw6-e2e -f "${ACCEPTANCE_DIR}/docker-compose.yml")
CONTAINER_NAME="paynl_sw6_e2e"
ENV_FILE="${ACCEPTANCE_DIR}/.env"
DIAGNOSTICS_DIR="${ACCEPTANCE_DIR}/diagnostics"
TUNNEL_LOG="${ACCEPTANCE_DIR}/diagnostics/tunnel.log"
TUNNEL_PID_FILE="${ACCEPTANCE_DIR}/diagnostics/tunnel.pid"

SHOPWARE_VERSION="${SHOPWARE_VERSION:-6.7.10.0}"
SHOPWARE_PORT="${SHOPWARE_PORT:-8080}"
SHOPWARE_WAIT_SECONDS="${SHOPWARE_WAIT_SECONDS:-600}"

export SHOPWARE_VERSION SHOPWARE_PORT

log() {
    printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"
}

fail() {
    log "error: $*"
    exit 1
}

ensure_env_file() {
    if [[ ! -f "${ENV_FILE}" ]]; then
        cp "${ACCEPTANCE_DIR}/.env.example" "${ENV_FILE}"
    fi
}

set_env_value() {
    local key="$1"
    local value="$2"
    ensure_env_file
    if grep -q "^${key}=" "${ENV_FILE}"; then
        local escaped
        escaped="$(printf '%s' "${value}" | sed 's/[&|]/\\&/g')"
        if sed --version >/dev/null 2>&1; then
            sed -i "s|^${key}=.*|${key}=${escaped}|" "${ENV_FILE}"
        else
            sed -i '' "s|^${key}=.*|${key}=${escaped}|" "${ENV_FILE}"
        fi
    else
        printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
    fi
    export "${key}=${value}"
}

load_env_file() {
    ensure_env_file
    while IFS= read -r line || [[ -n "${line}" ]]; do
        [[ "${line}" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue
        [[ "${line}" != *=* ]] && continue
        local key="${line%%=*}"
        local value="${line#*=}"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        if [[ -z "${!key:-}" ]]; then
            export "${key}=${value}"
        fi
    done < "${ENV_FILE}"
}

require_pay_secrets() {
    [[ -n "${PAY_TOKEN_CODE:-}" ]] || fail "PAY_TOKEN_CODE is not set"
    [[ -n "${PAY_API_TOKEN:-}" ]] || fail "PAY_API_TOKEN is not set"
    [[ -n "${PAY_SERVICE_ID:-}" ]] || fail "PAY_SERVICE_ID is not set"
}

shopware_exec() {
    docker exec -u dockware -i "${CONTAINER_NAME}" bash -lc "$*"
}

http_code() {
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "$1" 2>/dev/null || true)"
    printf '%s' "${code:-000}"
}

wait_for_dockware_ready() {
    log "Waiting for Dockware to unpack Shopware (Apache is down during this; connection resets are normal)"
    local elapsed=0
    while true; do
        if docker logs "${CONTAINER_NAME}" 2>&1 | grep -q 'container IS READY'; then
            log "Dockware reports the container is ready"
            # Bind-mount of the plugin is chowned by Dockware; the host/CI user must still write .env and diagnostics.
            docker exec "${CONTAINER_NAME}" bash -lc \
                'chmod -R a+rwX /var/www/html/custom/plugins/PaynlPaymentShopware6/tests/Acceptance || true'
            sleep 3
            return
        fi
        if (( elapsed >= SHOPWARE_WAIT_SECONDS )); then
            "${COMPOSE[@]}" logs --tail 80 shopware || true
            fail "Dockware did not finish startup within ${SHOPWARE_WAIT_SECONDS}s"
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        log "still unpacking Dockware (${elapsed}s)"
    done
}

shopware_mysql() {
    docker exec -e MYSQL_PWD=root "${CONTAINER_NAME}" \
        mysql -h 127.0.0.1 -u root --batch --raw --skip-column-names shopware -e "$1"
}

sql_escape() {
    printf '%s' "$1" | sed "s/'/''/g"
}

ensure_sales_channel_domain() {
    local url="${1%/}"
    [[ -n "${url}" ]] || fail "sales channel domain URL is empty"
    local escaped
    escaped="$(sql_escape "${url}")"
    log "Ensuring sales channel domain ${url}"

    local existing
    existing="$(shopware_mysql "SELECT url FROM sales_channel_domain WHERE url='${escaped}' LIMIT 1" || true)"
    if [[ -n "${existing}" ]]; then
        log "Sales channel domain already has ${url}"
        return
    fi

    if [[ "${url}" == "http://127.0.0.1:${SHOPWARE_PORT}" ]]; then
        shopware_mysql "UPDATE sales_channel_domain
            SET url='${escaped}', updated_at=NOW(3)
            WHERE url IN ('http://localhost', 'http://localhost/', 'http://localhost:80')"
        existing="$(shopware_mysql "SELECT url FROM sales_channel_domain WHERE url='${escaped}' LIMIT 1" || true)"
        if [[ -n "${existing}" ]]; then
            shopware_exec 'cd /var/www/html && php bin/console cache:clear -n'
            return
        fi
    fi

    if shopware_mysql "INSERT INTO sales_channel_domain
        (id, sales_channel_id, language_id, url, currency_id, snippet_set_id, hreflang_use_only_locale, created_at)
        SELECT UNHEX(REPLACE(UUID(), '-', '')), sales_channel_id, language_id, '${escaped}',
            currency_id, snippet_set_id, hreflang_use_only_locale, NOW(3)
        FROM sales_channel_domain
        WHERE url NOT LIKE 'default.headless%'
        ORDER BY created_at
        LIMIT 1"; then
        shopware_exec 'cd /var/www/html && php bin/console cache:clear -n'
        return
    fi

    log "Insert failed; pointing existing storefront domain at ${url}"
    shopware_mysql "UPDATE sales_channel_domain
        SET url='${escaped}', updated_at=NOW(3)
        WHERE url NOT LIKE 'default.headless%'
        LIMIT 1"
    shopware_exec 'cd /var/www/html && php bin/console cache:clear -n'
}

wait_for_shopware() {
    wait_for_dockware_ready
    local health="http://127.0.0.1:${SHOPWARE_PORT}/api/_info/health-check"
    local storefront="http://127.0.0.1:${SHOPWARE_PORT}/"
    log "Waiting for Shopware HTTP on port ${SHOPWARE_PORT}"
    local elapsed=0
    local health_code="000"
    local store_code="000"
    while true; do
        health_code="$(http_code "${health}")"
        store_code="$(http_code "${storefront}")"
        if [[ "${health_code}" == "200" || "${health_code}" == "204" ]]; then
            break
        fi
        # 500 is Shopware's "unknown domain" help page; 200 is a mapped storefront.
        if [[ "${store_code}" == "200" || "${store_code}" == "400" || "${store_code}" == "500" ]]; then
            log "Shopware HTTP is up (storefront ${store_code}, health-check ${health_code})"
            break
        fi
        if (( elapsed >= 120 )); then
            "${COMPOSE[@]}" logs --tail 80 shopware || true
            fail "Shopware HTTP did not become ready within 120s after Dockware startup (health-check ${health_code}, storefront ${store_code})"
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        log "still waiting for HTTP (${elapsed}s, health-check ${health_code}, storefront ${store_code})"
    done
    log "Shopware is responding"
    ensure_sales_channel_domain "http://127.0.0.1:${SHOPWARE_PORT}"
}

admin_token() {
    local base_url="${ADMIN_API_URL:-http://127.0.0.1:${SHOPWARE_PORT}/}"
    base_url="${base_url%/}"
    curl -fsS -X POST "${base_url}/api/oauth/token" \
        -H 'Content-Type: application/json' \
        -d "$(printf '{"client_id":"administration","grant_type":"password","username":"%s","password":"%s"}' \
            "${SHOPWARE_ADMIN_USERNAME:-admin}" "${SHOPWARE_ADMIN_PASSWORD:-shopware}")" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

write_github_env() {
    local key="$1"
    local value="$2"
    if [[ -n "${GITHUB_ENV:-}" ]]; then
        printf '%s=%s\n' "${key}" "${value}" >> "${GITHUB_ENV}"
    fi
}

start_tunnel() {
    mkdir -p "${DIAGNOSTICS_DIR}"
    : > "${TUNNEL_LOG}"
    local target="http://127.0.0.1:${SHOPWARE_PORT}"
    local public_url=""

    if [[ -n "${NGROK_AUTHTOKEN:-}" ]] && command -v ngrok >/dev/null 2>&1; then
        log "Starting ngrok tunnel to ${target}"
        ngrok http "${SHOPWARE_PORT}" --request-header-add "X-Forwarded-Proto:https" --log=stdout >"${TUNNEL_LOG}" 2>&1 &
        echo $! > "${TUNNEL_PID_FILE}"
        local elapsed=0
        while (( elapsed < 45 )); do
            if curl -fsS http://127.0.0.1:4040/api/tunnels >/dev/null 2>&1; then
                public_url="$(curl -fsS http://127.0.0.1:4040/api/tunnels \
                    | python3 -c 'import json,sys
t=json.load(sys.stdin).get("tunnels",[])
https=[x["public_url"] for x in t if x.get("public_url","").startswith("https://")]
print(https[0] if https else "")')"
                [[ -n "${public_url}" ]] && break
            fi
            sleep 2
            elapsed=$((elapsed + 2))
        done
    elif command -v cloudflared >/dev/null 2>&1; then
        log "Starting cloudflared tunnel to ${target}"
        cloudflared tunnel --url "${target}" --no-autoupdate >"${TUNNEL_LOG}" 2>&1 &
        echo $! > "${TUNNEL_PID_FILE}"
        local elapsed=0
        while (( elapsed < 45 )); do
            public_url="$(grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' "${TUNNEL_LOG}" | head -n 1 || true)"
            [[ -n "${public_url}" ]] && break
            sleep 2
            elapsed=$((elapsed + 2))
        done
    else
        fail "Install cloudflared or ngrok so PAY. can reach a public HTTPS callback URL"
    fi

    [[ -n "${public_url}" ]] || fail "Could not determine the public tunnel URL. See ${TUNNEL_LOG}"
    public_url="${public_url%/}/"
    log "Public shop URL: ${public_url}"
    set_env_value APP_URL "${public_url}"
    set_env_value ADMIN_API_URL "http://127.0.0.1:${SHOPWARE_PORT}/"
    write_github_env APP_URL "${public_url}"
    write_github_env ADMIN_API_URL "http://127.0.0.1:${SHOPWARE_PORT}/"
}

stop_tunnel() {
    if [[ -f "${TUNNEL_PID_FILE}" ]]; then
        local pid
        pid="$(cat "${TUNNEL_PID_FILE}")"
        kill "${pid}" >/dev/null 2>&1 || true
        wait "${pid}" 2>/dev/null || true
        rm -f "${TUNNEL_PID_FILE}"
    fi
    pkill -f 'cloudflared tunnel' >/dev/null 2>&1 || true
    pkill -f 'ngrok http' >/dev/null 2>&1 || true
}

install_plugin_sdk() {
    log "Installing paynl/php-sdk into Shopware so the plugin requirement check passes"
    shopware_exec 'set -e
cd /var/www/html
composer require "paynl/php-sdk:>=0.2.6 <1.1.0" --no-interaction --ignore-platform-reqs --no-scripts
PLUGIN=/var/www/html/custom/plugins/PaynlPaymentShopware6
mkdir -p "$PLUGIN/vendor"
if [[ -d vendor/paynl ]]; then cp -a vendor/paynl "$PLUGIN/vendor/"; fi
if [[ -d vendor/php-curl-class ]]; then cp -a vendor/php-curl-class "$PLUGIN/vendor/"; fi
'
}

configure_shopware() {
    load_env_file
    require_pay_secrets
    local app_url="${APP_URL:?APP_URL is not set}"
    app_url="${app_url%/}"

    log "Pointing Shopware APP_URL at ${app_url}"
    docker exec -u dockware -e APP_URL_VALUE="${app_url}" -i "${CONTAINER_NAME}" bash -lc 'set -e
cd /var/www/html
if [[ -f .env ]]; then
  grep -q "^APP_URL=" .env && sed -i "s|^APP_URL=.*|APP_URL=${APP_URL_VALUE}|" .env || echo "APP_URL=${APP_URL_VALUE}" >> .env
  grep -q "^TRUSTED_PROXIES=" .env && sed -i "s|^TRUSTED_PROXIES=.*|TRUSTED_PROXIES=127.0.0.1,REMOTE_ADDR|" .env || echo "TRUSTED_PROXIES=127.0.0.1,REMOTE_ADDR" >> .env
  if grep -q "^TRUSTED_HEADERS=" .env; then
    sed -i "s|^TRUSTED_HEADERS=.*|TRUSTED_HEADERS=x-forwarded-for,x-forwarded-host,x-forwarded-proto,x-forwarded-port,x-forwarded-prefix|" .env
  else
    echo "TRUSTED_HEADERS=x-forwarded-for,x-forwarded-host,x-forwarded-proto,x-forwarded-port,x-forwarded-prefix" >> .env
  fi
  grep -q "^SHOPWARE_HTTP_CACHE_ENABLED=" .env && sed -i "s|^SHOPWARE_HTTP_CACHE_ENABLED=.*|SHOPWARE_HTTP_CACHE_ENABLED=0|" .env || echo "SHOPWARE_HTTP_CACHE_ENABLED=0" >> .env
fi
'
    ensure_sales_channel_domain "${app_url}"
    if [[ "${app_url}" == https://* ]]; then
        ensure_sales_channel_domain "http://${app_url#https://}"
    fi

    install_plugin_sdk

    log "Installing and activating PaynlPaymentShopware6"
    shopware_exec 'set -e
cd /var/www/html
php bin/console plugin:refresh -n
if ! php bin/console plugin:install --activate PaynlPaymentShopware6 -n; then
  php bin/console plugin:activate PaynlPaymentShopware6 -n
fi
php bin/console plugin:list -n | awk "/PaynlPaymentShopware6/" | grep -q "Yes" \
  || { echo "PaynlPaymentShopware6 is not installed"; php bin/console plugin:list -n; exit 1; }
php bin/console cache:clear -n
'

    log "Writing PAY. test-mode credentials"
    docker exec \
        -u dockware \
        -e PAY_TOKEN_CODE="${PAY_TOKEN_CODE}" \
        -e PAY_API_TOKEN="${PAY_API_TOKEN}" \
        -e PAY_SERVICE_ID="${PAY_SERVICE_ID}" \
        -i "${CONTAINER_NAME}" bash -lc 'set -e
cd /var/www/html
php bin/console system:config:set PaynlPaymentShopware6.config.tokenCode "$PAY_TOKEN_CODE" -n
php bin/console system:config:set PaynlPaymentShopware6.config.apiToken "$PAY_API_TOKEN" -n
php bin/console system:config:set PaynlPaymentShopware6.config.serviceId "$PAY_SERVICE_ID" -n
php bin/console system:config:set PaynlPaymentShopware6.config.testMode 1 -n
php bin/console system:config:set PaynlPaymentShopware6.config.useSinglePaymentMethod 1 -n
php bin/console system:config:set PaynlPaymentShopware6.config.logging 1 -n
php bin/console system:config:set PaynlPaymentShopware6.config.paymentScreenLanguage en -n
php bin/console system:config:set core.loginRegistration.minPasswordLength 8 -n
php bin/console cache:clear -n
'

    log "Installing PAY. payment methods"
    local token
    token="$(admin_token)"
    local api_url="${ADMIN_API_URL:-http://127.0.0.1:${SHOPWARE_PORT}/}"
    api_url="${api_url%/}"
    local response
    response="$(curl -fsS "${api_url}/api/paynl/install-payment-methods?_nocache=$(date +%s)" \
        -H "Authorization: Bearer ${token}" \
        -H 'Accept: application/json' \
        -H 'Cache-Control: no-cache, no-store' \
        -H 'Pragma: no-cache')"
    python3 -c 'import json,sys
payload=json.loads(sys.argv[1])
if not payload.get("success", True):
    raise SystemExit(payload.get("message", "install-payment-methods failed"))
print(payload.get("message", "payment methods installed"))
' "${response}"

    log "Shop configuration complete"
}

collect_diagnostics() {
    mkdir -p "${DIAGNOSTICS_DIR}"
    log "Collecting Shopware diagnostics into ${DIAGNOSTICS_DIR}"
    docker ps -a --filter "name=${CONTAINER_NAME}" > "${DIAGNOSTICS_DIR}/docker-ps.txt" || true
    "${COMPOSE[@]}" logs --no-color shopware > "${DIAGNOSTICS_DIR}/shopware-container.log" 2>/dev/null || true
    shopware_exec 'cd /var/www/html
php bin/console plugin:list -n || true
echo "---- .env APP_URL ----"
grep -E "^(APP_URL|TRUSTED_PROXIES)=" .env || true
echo "---- paynl logs ----"
ls -la var/log || true
' > "${DIAGNOSTICS_DIR}/shopware-console.txt" 2>&1 || true
    docker cp "${CONTAINER_NAME}:/var/www/html/var/log/." "${DIAGNOSTICS_DIR}/shopware-var-log" 2>/dev/null || true
}

cmd_up() {
    load_env_file
    mkdir -p "${DIAGNOSTICS_DIR}"
    log "Starting Shopware ${SHOPWARE_VERSION} on port ${SHOPWARE_PORT}"
    "${COMPOSE[@]}" pull shopware
    "${COMPOSE[@]}" up -d --force-recreate
    wait_for_shopware
    start_tunnel
    configure_shopware
    log "Environment is ready. APP_URL=${APP_URL}"
}

cmd_down() {
    stop_tunnel
    "${COMPOSE[@]}" down -v --remove-orphans || true
    log "Temporary Shopware environment removed"
}

usage() {
    cat <<'EOF'
Usage: e2e-env.sh <up|down|diagnostics|configure|ensure-plugin|tunnel>

  up            Start Shopware, open a public HTTPS tunnel, install the plugin
  configure     Re-run plugin/PAY. configuration (requires APP_URL)
  ensure-plugin Install and activate PaynlPaymentShopware6, then PAY. test methods
  tunnel        Start only the public HTTPS tunnel
  diagnostics   Copy Shopware logs for CI artifacts
  down          Stop the tunnel and delete the Shopware containers
EOF
}

case "${1:-}" in
    up) cmd_up ;;
    down) cmd_down ;;
    diagnostics) collect_diagnostics ;;
    configure) load_env_file; configure_shopware ;;
    ensure-plugin) load_env_file; configure_shopware ;;
    tunnel) load_env_file; start_tunnel ;;
    *) usage; exit 1 ;;
esac
