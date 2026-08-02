/**
 * Trusted spawn construction.
 *
 * Every Pi subprocess is invoked through a canonical absolute trusted
 * interpreter with the absolute verified Pi entry path, and a fixed minimal
 * PATH that never incorporates caller PATH.
 */

import { isAbsolute } from "node:path";

const TRUSTED_INTERPRETER = process.execPath;
const TRUSTED_PATH = "/usr/bin:/bin";

export function trustedInterpreter() {
  if (!isAbsolute(TRUSTED_INTERPRETER)) {
    throw new Error("trusted interpreter path must be absolute");
  }
  return TRUSTED_INTERPRETER;
}

export function trustedPath() {
  return TRUSTED_PATH;
}

export function trustedSpawnArgs(launcherPath, piArgs) {
  if (!launcherPath || !isAbsolute(launcherPath)) {
    throw new Error("Pi launcher path must be absolute");
  }
  return [trustedInterpreter(), [launcherPath, ...piArgs]];
}

export function trustedChildEnv(baseEnv) {
  const env = {};
  for (const key of Object.keys(baseEnv || {})) {
    if (key !== "PATH") {
      env[key] = baseEnv[key];
    }
  }
  env.PATH = TRUSTED_PATH;
  return env;
}
