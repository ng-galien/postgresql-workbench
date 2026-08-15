ARG NODE_VERSION=22.23.2
FROM node:${NODE_VERSION}-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS node-runtime

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

ARG VSCODE_VERSION=1.109.0

USER root

COPY --from=node-runtime /usr/local/ /usr/local/

RUN apt-get update \
  && apt-get install -y --no-install-recommends scrot xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && node --version | grep -E '^v22\.'

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY vscode-extension/package.json vscode-extension/package-lock.json ./vscode-extension/

RUN npm ci \
  && npm --prefix vscode-extension ci

ENV PGWB_ACCEPTANCE_VSCODE_VERSION=${VSCODE_VERSION}

# Cache the exact VS Code runtime in the image. Runtime setup still validates
# the executable, but no lane races another download and CI never follows the
# moving "stable" channel.
RUN cd vscode-extension \
  && node -e 'require("@vscode/test-electron").downloadAndUnzipVSCode({ version: process.env.PGWB_ACCEPTANCE_VSCODE_VERSION, timeout: 30000 }).catch((error) => { console.error(error); process.exit(1); })'

COPY . .

ENV CI=true
ENV PGWB_ACCEPTANCE_EXTERNAL_DEMO=1
ENV PGWB_PLAYWRIGHT_MINIMAL_DIAGNOSTICS=1

ENTRYPOINT ["xvfb-run", "-a", "-s", "-screen 0 1600x1000x24", "bash", "vscode-extension/scripts/run-playwright-ci.sh"]
CMD ["test:acceptance"]
