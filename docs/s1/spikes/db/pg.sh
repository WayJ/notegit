#!/bin/sh
# THROWAWAY spike: manage the postgres:17-alpine container for S1-T1 DB probes.
# Port 55432 avoids colliding with any local postgres default install.
set -e
CMD="${1:-help}"
case "$CMD" in
  start)
    docker run -d --name s1-t1-pg-spike -e POSTGRES_USER=spike -e POSTGRES_PASSWORD=spike-pw \
      -e POSTGRES_DB=spike -p 127.0.0.1:55432:5432 postgres:17-alpine >/dev/null
    until docker exec s1-t1-pg-spike pg_isready -U spike -d spike >/dev/null 2>&1; do sleep 0.3; done
    echo "postgres up on 127.0.0.1:55432" ;;
  stop)
    docker rm -f s1-t1-pg-spike >/dev/null 2>&1 || true
    echo "postgres removed" ;;
  *) echo "usage: ./pg.sh start|stop" ;;
esac
