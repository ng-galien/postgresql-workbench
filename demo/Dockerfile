FROM galien0xffffff/postgres-debugger:17@sha256:bf8a7b9d3d7b204f95ca1ca76395e93066598079e21cac600b894c02e2a20cdc

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-pgtap \
  && rm -rf /var/lib/apt/lists/*
