#!/usr/bin/env bash
# Ensures what the app's admin Users section needs in the learnharness realm
# (docs/self-hosting.md, "Users"), idempotently, on every stack start:
#   - the group learnharness-admin
#   - the confidential client learnharness-admin-api (service account only),
#     its secret = KC_ADMIN_API_SECRET from secrets.env
#   - its service account holding realm-management view-users, query-users,
#     query-groups and manage-users
#
# Usage: bootstrap-keycloak.sh <secrets.env>
# Runs kcadm inside the Keycloak container. Secrets never reach argv or the
# log: the admin password goes in as KC_CLI_PASSWORD, the client secret on
# stdin. Always exits 0: a failure prints "keycloak bootstrap failed" and the
# app shows "user management is not configured" until the next start.
set -euo pipefail
shopt -s inherit_errexit

container=${KC_CONTAINER:-learnharness-keycloak-1}
realm=learnharness
client=learnharness-admin-api
group=learnharness-admin
kcconfig=/tmp/kcadm-bootstrap

cleanup() {
	docker exec "$container" rm -f "$kcconfig" >/dev/null 2>&1 || true
}
finish() {
	local rc=$?
	cleanup
	if [ "$rc" -ne 0 ]; then
		echo "keycloak bootstrap failed" >&2
	fi
	exit 0
}
trap finish EXIT

secrets=${1:?usage: bootstrap-keycloak.sh <secrets.env>}
val() { sed -n "s/^$1=//p" "$secrets" | tail -n 1; }
admin_user=$(val KC_ADMIN_USER)
admin_password=$(val KC_ADMIN_PASSWORD)
api_secret=$(val KC_ADMIN_API_SECRET)
if [ -z "$admin_user" ] || [ -z "$admin_password" ] || [ -z "$api_secret" ]; then
	echo "bootstrap-keycloak: KC_ADMIN_USER, KC_ADMIN_PASSWORD or KC_ADMIN_API_SECRET missing in $secrets" >&2
	exit 1
fi
# It is embedded in a JSON body below; the stack generates hex.
if ! [[ $api_secret =~ ^[A-Za-z0-9_-]+$ ]]; then
	echo "bootstrap-keycloak: KC_ADMIN_API_SECRET must be [A-Za-z0-9_-]" >&2
	exit 1
fi

kc() { docker exec "$container" /opt/keycloak/bin/kcadm.sh "$@" --config "$kcconfig"; }

# Keycloak may still be starting: try to log in every 5 s for up to 3 minutes.
logged_in=false
for _ in $(seq 1 36); do
	if KC_CLI_PASSWORD=$admin_password docker exec -e KC_CLI_PASSWORD "$container" \
		/opt/keycloak/bin/kcadm.sh config credentials --config "$kcconfig" \
		--server http://localhost:8080 --realm master --user "$admin_user" >/dev/null 2>&1; then
		logged_in=true
		break
	fi
	sleep 5
done
if [ "$logged_in" != true ]; then
	echo "bootstrap-keycloak: could not log in to Keycloak within 3 minutes" >&2
	exit 1
fi

# Group.
# (Outputs are captured before matching: a grep -q that exits early could fail the pipeline.)
groups=$(kc get groups -r "$realm" -q search="$group" --fields name --format csv --noquotes)
if ! grep -qx -- "$group" <<<"$groups"; then
	kc create groups -r "$realm" -s name="$group" >/dev/null
	echo "bootstrap-keycloak: created group $group"
fi

# Client.
client_id() {
	local out
	out=$(kc get clients -r "$realm" -q clientId="$client" --fields id --format csv --noquotes)
	printf '%s\n' "${out%%$'\n'*}"
}
id=$(client_id)
if [ -z "$id" ]; then
	kc create clients -r "$realm" -s clientId="$client" -s publicClient=false -s serviceAccountsEnabled=true \
		-s standardFlowEnabled=false -s directAccessGrantsEnabled=false >/dev/null
	id=$(client_id)
	echo "bootstrap-keycloak: created client $client"
fi
[ -n "$id" ]
# Re-assert the flags and the secret every time (merge: other attributes stay).
printf '{"publicClient":false,"serviceAccountsEnabled":true,"standardFlowEnabled":false,"implicitFlowEnabled":false,"directAccessGrantsEnabled":false,"clientAuthenticatorType":"client-secret","secret":"%s"}' "$api_secret" |
	docker exec -i "$container" /opt/keycloak/bin/kcadm.sh update "clients/$id" -r "$realm" --merge -f - --config "$kcconfig" >/dev/null

# Service account roles (adding an existing mapping is a no-op). The user is
# addressed by id from the client, which works however Keycloak filters
# service accounts out of user searches.
sa=$(kc get "clients/$id/service-account-user" -r "$realm" --fields id --format csv --noquotes)
[ -n "$sa" ]
kc add-roles -r "$realm" --uid "$sa" --cclientid realm-management \
	--rolename view-users --rolename query-users --rolename query-groups --rolename manage-users

echo "bootstrap-keycloak: realm $realm ready (group $group, client $client)"
