# Pool Proof Builder Profile Sandbox

This directory defines the Pool Proof builder profile and its pinned sandbox image.

## Build the sandbox image

The image has no default base; you must supply a pinned base image by digest.
Docker cannot tag an image as `name@sha256`, so build a normal local tag from a
digest-pinned `BASE_IMAGE` using this profile Dockerfile and context, then inspect
`.Id` and pass the exact `sha256:<id>` reference to preflight/proof.

```bash
docker build \
  --build-arg BASE_IMAGE=node:24-alpine@sha256:<base-digest> \
  -t agent-pool-pool-proof-sandbox:local \
  -f packages/worker-harness/profiles/pool-proof-builder/Dockerfile \
  packages/worker-harness/profiles/pool-proof-builder
```

## Inspect a built image

```bash
docker image inspect --format='{{.Id}} {{.Config.User}}' agent-pool-pool-proof-sandbox:local
```

The command prints the exact local image ID (for example `sha256:abc123...`)
along with the configured user. Preflight and proof accept only an exact
`sha256:<64-hex-id>` reference:

```bash
node packages/pool-proof-harness/src/preflight.ts \
  --pi /path/to/pi \
  --model openai-codex/gpt-5.6-terra \
  --container-runtime docker \
  --sandbox-image sha256:<64-hex-id-from-inspect>
```

The image must:
- be referenced by exact `sha256:<64-hex-id>` (no tag, no `name@sha256`, no `:latest`);
- be configured to run as a non-root user;
- contain the broker executable at `/usr/local/bin/pool-proof-broker`;
- have `/workspace` as the working directory with a writable `/workspace/.home`.

## Launcher-owned sandbox identity

The launcher selects the sandbox UID:GID mapping from the host process:

- Non-root launcher: the container runs as the current host uid:gid so the
  bind-mounted workspace is writable.
- Root launcher: the fixture workspace is provisioned and chowned to the pinned
  non-root identity `1001:1001`, and the container runs as `1001:1001`.

Container execution as uid 0 is rejected. The same mapping is used for base-red
runs, the broker repository sandbox, verifier fixture runs, and real proof
startup.

## Run the broker manually

```bash
echo '{"tool":"bash","command":"pwd"}' | docker run --rm -i \
  --network=none --cap-drop=ALL --security-opt=no-new-privileges \
  --read-only --user "$(id -u):$(id -g)" \
  -v $(pwd)/fixture:/workspace:rw \
  -e HOME=/workspace/.home \
  sha256:<64-hex-id>
```

When the launcher is root, replace `--user "$(id -u):$(id -g)"` with
`--user 1001:1001` and ensure the fixture is owned by `1001:1001`.
