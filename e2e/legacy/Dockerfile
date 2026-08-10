ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-bookworm

ARG PG_MAJOR
ARG PLDEBUGGER_REF=ff0db437fc4e8dc75447e0e2fd792494249b05b4

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      libkrb5-dev \
      postgresql-server-dev-${PG_MAJOR} \
    && git clone https://github.com/EnterpriseDB/pldebugger.git /tmp/pldebugger \
    && cd /tmp/pldebugger \
    && git checkout "${PLDEBUGGER_REF}" \
    && make USE_PGXS=1 \
    && make USE_PGXS=1 install \
    && rm -rf /tmp/pldebugger /var/lib/apt/lists/*
