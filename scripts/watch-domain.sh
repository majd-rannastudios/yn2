#!/usr/bin/env bash
# Poll until the custom domain serves HTTPS. Uses --resolve so a stale local
# negative-cache entry cannot mask a domain that is actually up.
# Usage: scripts/watch-domain.sh <custom domain> <railway CNAME target>
#   e.g. scripts/watch-domain.sh event.yarnoo.com abc123.up.railway.app
HOST=${1:?usage: watch-domain.sh <custom domain> <railway CNAME target>}
TARGET=${2:?usage: watch-domain.sh <custom domain> <railway CNAME target>}
START=$(date +%s)

for i in $(seq 1 144); do
  IP=$(nslookup "$TARGET" 8.8.8.8 2>/dev/null | awk '/^Address:/{print $2}' | tail -1)
  PUBLIC_DNS=$(nslookup -type=CNAME "$HOST" 8.8.8.8 2>/dev/null | grep -ci "canonical name")

  if [ -n "$IP" ]; then
    CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
      --resolve "$HOST:443:$IP" "https://$HOST/health" 2>/dev/null)
    if [ "$CODE" = "200" ]; then
      MINS=$(( ($(date +%s) - START) / 60 ))
      echo "=========================================="
      echo "  DOMAIN IS LIVE  (after ~${MINS} min)"
      echo "=========================================="
      echo "  https://$HOST"
      echo ""
      echo "  public DNS visible: $([ "$PUBLIC_DNS" -gt 0 ] && echo yes || echo 'not yet, cert is up though')"
      echo "  health: $(curl -s --max-time 15 --resolve "$HOST:443:$IP" "https://$HOST/health")"
      echo ""
      echo "  certificate:"
      curl -sv --max-time 15 --resolve "$HOST:443:$IP" "https://$HOST/health" 2>&1 \
        | grep -iE "subject:|issuer:|expire date" | sed 's/^\*/   /'
      exit 0
    fi
  fi
  sleep 300
done

echo "Still not serving after 12 hours. Railway docs allow up to 72h; past that it is a support ticket."
exit 1
