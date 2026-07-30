FROM node:24.18.0-slim

# Build metadata.
ARG GRAPHIFY_VERSION=0.9.25
ENV AGENT_POOL_WORKER_HARNESS=true

# Create a non-root worker user and workspace.
RUN groupadd -r worker && useradd -r -g worker -d /workspace -m worker
WORKDIR /workspace

# Install the pinned Graphify Python release (PyPI package name is graphifyy).
# The CLI is invoked as `graphify`; --version must equal GRAPHIFY_VERSION.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
    pip3 install --break-system-packages graphifyy==${GRAPHIFY_VERSION} && \
    graphify --version && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy the worker harness.
COPY --chown=worker:worker . /opt/agent-pool-worker-harness
WORKDIR /opt/agent-pool-worker-harness

# Run as non-root.
USER worker

# Validate the pinned toolchain on container start.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node scripts/preflight.mjs || exit 1

CMD ["node", "scripts/preflight.mjs"]
