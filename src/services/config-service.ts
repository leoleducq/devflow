import type { PrismaClient, DevflowConfig } from "../db/types.js";

/** Settings a user may change with `devflow config set`. */
export const CONFIG_FIELDS = [
  "portRangeStart",
  "portRangeSize",
  "dbDefaultPort",
  "dbSeedStrategy",
  "worktreeLocation",
  "dockerNetwork",
  "dockerVolumePrefix",
] as const;

export type ConfigField = (typeof CONFIG_FIELDS)[number];

export type ConfigUpdate = Partial<Pick<DevflowConfig, ConfigField>>;

const DEFAULT_CONFIG: Required<ConfigUpdate> = {
  portRangeStart: 3000,
  portRangeSize: 100,
  dbDefaultPort: 5432,
  dbSeedStrategy: "COPY_MAIN",
  worktreeLocation: ".devflow/worktrees",
  dockerNetwork: "devflow",
  dockerVolumePrefix: "devflow",
};

export const SEED_STRATEGIES = [
  "COPY_MAIN",
  "FRESH_MIGRATE",
  "SNAPSHOT",
] as const;

export class ConfigService {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrCreateConfig(): Promise<DevflowConfig> {
    const existing = await this.prisma.devflowConfig.findFirst();
    if (existing) {
      return existing;
    }

    return this.prisma.devflowConfig.create({
      data: DEFAULT_CONFIG,
    });
  }

  async updateConfig(updates: ConfigUpdate): Promise<DevflowConfig> {
    validateConfigUpdate(updates);
    const config = await this.getOrCreateConfig();
    return this.prisma.devflowConfig.update({
      where: { id: config.id },
      data: updates,
    });
  }
}

/** Reject values that would make port allocation or seeding impossible. */
export function validateConfigUpdate(updates: ConfigUpdate): void {
  const { portRangeStart, portRangeSize, dbDefaultPort, dbSeedStrategy } =
    updates;

  if (portRangeStart !== undefined && !isPort(portRangeStart)) {
    throw new Error("portRangeStart must be a port between 1024 and 65535");
  }
  if (portRangeSize !== undefined && (!isInteger(portRangeSize) || portRangeSize < 1)) {
    throw new Error("portRangeSize must be a positive integer");
  }
  if (dbDefaultPort !== undefined && !isPort(dbDefaultPort)) {
    throw new Error("dbDefaultPort must be a port between 1024 and 65535");
  }
  if (
    dbSeedStrategy !== undefined &&
    !SEED_STRATEGIES.includes(dbSeedStrategy as (typeof SEED_STRATEGIES)[number])
  ) {
    throw new Error(
      `dbSeedStrategy must be one of: ${SEED_STRATEGIES.join(", ")}`,
    );
  }
}

const isInteger = (value: number): boolean => Number.isInteger(value);
const isPort = (value: number): boolean =>
  isInteger(value) && value >= 1024 && value <= 65535;
