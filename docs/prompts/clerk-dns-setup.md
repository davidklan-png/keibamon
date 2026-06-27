# CLI agent prompt — Clerk production DNS for keibamon.com

> Run on the **Mac** (mac-dev: has outbound DNS + David's Cloudflare creds).
> Goal: get all five Clerk CNAMEs present, correct, and **DNS-only** so Clerk's
> production instance verifies and can issue TLS — the last gate before the app
> goes live for real users this weekend. The Cowork/Claude agent is the
> verifier; note it CANNOT resolve DNS from its sandbox, so the proof here is
> your `dig` output + Clerk's verification state.

```
You are configuring Clerk production DNS for keibamon.com. Do NOT guess access.
Confirm the provider, report the current state of each record (missing vs wrong
value), then add/fix them — idempotently, DNS-only — and tell David to re-run
Clerk verification. Never print the CF API token. Use the values EXACTLY as
written; do not transcribe from screenshots.

## STEP 0 — Confirm provider + current state (report BEFORE changing anything)
  dig +short NS keibamon.com          # expect *.ns.cloudflare.com → Cloudflare DNS
  for h in accounts clerk clk._domainkey clk2._domainkey clkmail; do
    printf "%-16s -> " "$h"; dig +short CNAME "$h".keibamon.com || echo "(none)"
  done
Classify each of the 5 below as MISSING (empty) or WRONG (resolves to something
other than its target). Print that classification. If NS is not Cloudflare, STOP
and tell David which provider it is and that the API block assumes Cloudflare.

## Required records (exact)
  accounts          CNAME  accounts.clerk.services
  clerk             CNAME  frontend-api.clerk.services
  clk._domainkey    CNAME  dkim1.dptj83cdmc2m.clerk.services
  clk2._domainkey   CNAME  dkim2.dptj83cdmc2m.clerk.services
  clkmail           CNAME  mail.dptj83cdmc2m.clerk.services
All five MUST be proxied=false (grey cloud / "DNS only"). Clerk's DNS check
fails behind Cloudflare's proxy — an orange-clouded record stays "unverified"
forever regardless of value.

## STEP 1 — Apply (idempotent: create if missing, patch if wrong, fix proxy)
Needs a Cloudflare API token scoped Zone→DNS→Edit. Source it from a file/env
(do NOT echo it). Self-discover the zone id; don't hardcode.

  : "${CF_DNS_TOKEN:?source your Zone:DNS:Edit token into CF_DNS_TOKEN}"
  api(){ curl -s -H "Authorization: Bearer $CF_DNS_TOKEN" -H "Content-Type: application/json" "$@"; }
  ZONE=$(api "https://api.cloudflare.com/client/v4/zones?name=keibamon.com" | jq -r '.result[0].id')
  upsert(){ # $1=name $2=target
    local rec id cur prox
    rec=$(api "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?type=CNAME&name=$1.keibamon.com")
    id=$(echo "$rec" | jq -r '.result[0].id // empty')
    cur=$(echo "$rec" | jq -r '.result[0].content // empty')
    prox=$(echo "$rec" | jq -r '.result[0].proxied // empty')
    local body="{\"type\":\"CNAME\",\"name\":\"$1\",\"content\":\"$2\",\"proxied\":false,\"ttl\":1}"
    if [ -z "$id" ]; then
      echo "ADD  $1 -> $2"; api -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" --data "$body" | jq '.success,.errors'
    elif [ "$cur" != "$2" ] || [ "$prox" != "false" ]; then
      echo "FIX  $1 ($cur proxied=$prox) -> $2 proxied=false"; api -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$id" --data "$body" | jq '.success,.errors'
    else
      echo "OK   $1 already correct + DNS-only"
    fi; }
  upsert accounts        accounts.clerk.services
  upsert clerk           frontend-api.clerk.services
  upsert clk._domainkey  dkim1.dptj83cdmc2m.clerk.services
  upsert clk2._domainkey dkim2.dptj83cdmc2m.clerk.services
  upsert clkmail         mail.dptj83cdmc2m.clerk.services

(If David prefers the dashboard over the API: DNS → Records, add each with the
relative Name above, target as given, proxy toggled OFF. Same outcome.)

## STEP 2 — Confirm propagation, then hand the verify click to David
Re-run the STEP-0 dig loop against 1.1.1.1 to read authoritative values:
  for h in accounts clerk clk._domainkey clk2._domainkey clkmail; do
    printf "%-16s -> " "$h"; dig +short CNAME "$h".keibamon.com @1.1.1.1; done
All five must echo their exact target. Cloudflare usually propagates in minutes
(Clerk allows up to 48h). Clerk verification itself is a dashboard action the
agent can't click — tell David: Clerk Dashboard → Domains → re-run verification,
and (separately) check `dig keibamon.com +short CAA` is empty so cert issuance
isn't blocked.

## Constraints
- Never print the API token. Don't proxy any of these records. Don't touch the
  apex A/AAAA or the existing keibamon.com Worker routes — only the 5 CNAMEs.
- Exact target values only. No trailing dots added/removed beyond what the API
  normalizes.

## Handback to the verifier (Cowork/Claude)
Report: the STEP-0 classification (which were missing vs wrong), the upsert
output (ADD/FIX/OK per record), and the STEP-2 authoritative dig showing all
five resolving to the exact targets, plus CAA-empty confirmation. The verifier
can't resolve DNS from its sandbox, so it checks your dig output matches the
table exactly and that none are proxied; final "verified" is Clerk's Domains
page going green. After that + the live-key deploy, the verifier re-confirms the
auth chain (real prod users + follow edge + a persisted ticket) via the social
D1 connector.
```
