/**
 * Pool port resolution. The order at boot is: the --port CLI flag wins, then
 * the console.json pin, then the default 8787-or-next-free. A port that is
 * pinned (by flag or config) must bind exactly, or boot fails loudly naming
 * the port; only the unpinned path hunts for a free port. Port 0 means "any
 * free port", Bun's ephemeral semantics, and is never a pin.
 */

export const DEFAULT_PORT = 8787;

export interface PortResolution {
  port: number;
  pinned: boolean;
}

/** A port must be an integer in 0-65535. Port 0 means "any free port". */
export function validPort(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(
      `${source}: port must be an integer 0-65535, got ${value}`,
    );
  }
  return value;
}

export function resolvePort(
  cliPort: number | undefined,
  configPort: number | undefined,
  defaultPort = DEFAULT_PORT,
): PortResolution {
  if (cliPort !== undefined) {
    const port = validPort(cliPort, "--port");
    return { port, pinned: port !== 0 };
  }
  if (configPort !== undefined) {
    const port = validPort(configPort, "console.json");
    return { port, pinned: port !== 0 };
  }
  return { port: validPort(defaultPort, "default port"), pinned: false };
}