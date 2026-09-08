import getPort, { portNumbers } from "get-port";
import type { PrismaClient } from "../db/types.js";
import { ConfigService } from "./config-service.js";

export class PortService {
  private readonly configService: ConfigService;

  constructor(private readonly prisma: PrismaClient) {
    this.configService = new ConfigService(prisma);
  }

  async allocatePorts(
    environmentId: string,
    apps: string[],
    excludePorts: number[] = [],
  ): Promise<Array<{ appName: string; port: number }>> {
    const config = await this.configService.getOrCreateConfig();
    const startPort = config.portRangeStart;
    const endPort = startPort + config.portRangeSize;

    // Exclude ports already allocated in DB
    const existingAllocations = await this.prisma.portAllocation.findMany({
      select: { port: true },
    });
    const excluded = new Set([
      ...excludePorts,
      ...existingAllocations.map(a => a.port),
    ]);

    const allocations: Array<{ appName: string; port: number }> = [];

    for (const app of apps) {
      const port = await getPort({
        port: portNumbers(startPort, endPort),
        exclude: [...excluded],
      });
      excluded.add(port);

      const allocation = await this.prisma.portAllocation.create({
        data: {
          environmentId,
          appName: app,
          port,
        },
      });

      allocations.push({ appName: allocation.appName, port: allocation.port });
    }

    return allocations;
  }

  async allocateDatabasePort(): Promise<number> {
    const config = await this.configService.getOrCreateConfig();

    const usedPorts = await this.prisma.environmentDatabase.findMany({
      select: { port: true },
    });
    const usedPortNumbers = new Set(usedPorts.map(p => p.port));

    let port = config.dbDefaultPort;
    while (usedPortNumbers.has(port)) {
      port++;
    }

    return getPort({ port });
  }

  async releasePorts(environmentId: string): Promise<void> {
    await this.prisma.portAllocation.deleteMany({
      where: { environmentId },
    });
  }
}
