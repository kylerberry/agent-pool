# Buildable sandbox image for the Pool Proof builder profile.
#
# The base image MUST be supplied by digest at build time:
#   docker build --build-arg BASE_IMAGE=node:24-alpine@sha256:<digest> -t agent-pool-pool-proof-sandbox:local .
#
# No :latest tag is accepted. The broker script is the only entrypoint; it has
# no dependencies and performs all read/write/edit/bash operations inside /workspace.

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Pin base image metadata expectations. Bump these only after re-verifying the
# digest, Node version, and package set.
ARG NODE_VERSION=24
ARG BROKER_PATH=/usr/local/bin/pool-proof-broker
ARG UID=1001
ARG GID=1001

RUN apk add --no-cache git

# The pinned non-root identity. A non-root host launcher maps its own uid:gid
# into the container; a root launcher provisions the fixture for UID:GID.
RUN addgroup -g ${GID} pool && \
    adduser -u ${UID} -G pool -s /bin/sh -D pool

WORKDIR /workspace
RUN mkdir -p /workspace/.home/.config /workspace/.home/.cache /workspace/.home/.local/share && \
    chown -R pool:pool /workspace

COPY --chown=pool:pool broker.mjs ${BROKER_PATH}
RUN chmod 755 ${BROKER_PATH}

USER pool
ENV HOME=/workspace/.home
ENV XDG_CONFIG_HOME=/workspace/.home/.config
ENV XDG_CACHE_HOME=/workspace/.home/.cache
ENV XDG_DATA_HOME=/workspace/.home/.local/share

ENTRYPOINT ["node", "/usr/local/bin/pool-proof-broker"]
