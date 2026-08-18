FROM galien0xffffff/postgres-debugger:17@sha256:bf8a7b9d3d7b204f95ca1ca76395e93066598079e21cac600b894c02e2a20cdc

COPY demo/postgres-final-server-ready.sh /usr/local/bin/postgres-final-server-ready

# Canonical Workbench PostgreSQL fixture: pldbgapi comes from the pinned base
# image and pgTAP is installed once here for demo, integration, and benchmark
# Compose projects.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-pgtap \
  && chmod +x /usr/local/bin/postgres-final-server-ready \
  && rm -rf /var/lib/apt/lists/*

# docker-entrypoint.sh exposes only a Unix socket while it runs initialization
# scripts. TCP becomes reachable after the seed is complete and the final
# PostgreSQL server has started.
HEALTHCHECK --interval=2s --timeout=5s --retries=15 CMD ["postgres-final-server-ready"]
