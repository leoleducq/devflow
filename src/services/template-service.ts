import { execa } from "execa";
import fs from "fs-extra";
import path from "path";
import {
  detectPackageManager,
  type PackageManager,
} from "../lib/package-manager.js";

type CloneTemplateOptions = {
  templateRepo: string;
  targetPath: string;
  projectName: string;
};

type SetupGitHubRepoOptions = {
  targetPath: string;
  repoName: string;
  org?: string;
  isPrivate?: boolean;
};

type ProjectScaffoldResult = {
  path: string;
  apps: string[];
  type: "TURBOREPO" | "STANDARD";
};

export type ProjectInspection = {
  path: string;
  name: string | null;
  type: "TURBOREPO" | "STANDARD";
  apps: string[];
  devCommands: Record<string, string>;
  appPorts: Record<string, number>;
  dbEnvVarName: string | null;
  dbDockerImage: string | null;
  /** The manager the checkout declares or its lock file implies. */
  packageManager: PackageManager;
};

const DEFAULT_FRAMEWORK_PORTS: Record<string, number> = {
  next: 3000,
  "next dev": 3000,
  vite: 5173,
  remix: 3000,
  nuxt: 3000,
  astro: 4321,
  gatsby: 8000,
  "hono/node-server": 3000,
};

function extractPortFromScript(script: string): number | null {
  const flag = script.match(/(?:--port|-p)[= ](\d{2,5})/);
  if (flag?.[1]) return Number(flag[1]);
  const env = script.match(/PORT=(\d{2,5})/);
  if (env?.[1]) return Number(env[1]);
  for (const [needle, port] of Object.entries(DEFAULT_FRAMEWORK_PORTS)) {
    if (script.includes(needle)) return port;
  }
  return null;
}

function stripPortFromScript(script: string): string {
  return script
    .replace(/\s*(?:--port|-p)(?:[= ]\d{2,5})/g, "")
    .replace(/\s*PORT=\d{2,5}\s*/g, " ")
    .trim();
}

function extractPortFromEnvExample(
  content: string,
  appName: string,
): number | null {
  const upper = appName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const patterns = [
    new RegExp(`^${upper}_PORT\\s*=\\s*(\\d+)`, "m"),
    new RegExp(`^PORT_${upper}\\s*=\\s*(\\d+)`, "m"),
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

function extractDbEnvVarName(content: string): string | null {
  // The prefix is optional: plain `DATABASE_URL=` is by far the common case,
  // while `DIRECT_DATABASE_URL=` and friends keep working.
  const candidates = content.match(
    /^((?:[A-Z][A-Z0-9_]*_)?(?:DATABASE_URL|DB_URL))\s*=/gm,
  );
  if (!candidates?.length) return null;
  const first = candidates[0]!.match(/^([A-Z][A-Z0-9_]*)/);
  return first?.[1] ?? null;
}

function extractPostgresImage(compose: string): string | null {
  const services = compose.split(/^services:/m)[1] ?? compose;
  const lines = services.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const image = line.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/);
    if (!image) continue;
    const value = image[1]!;
    if (/postgres|pgvector|timescale/i.test(value)) return value;
  }
  return null;
}

export class TemplateService {
  async cloneTemplate(options: CloneTemplateOptions): Promise<void> {
    const { templateRepo, targetPath, projectName } = options;

    if (await fs.pathExists(targetPath)) {
      throw new Error(`Target path already exists: ${targetPath}`);
    }

    await fs.ensureDir(path.dirname(targetPath));

    // Shallow clone + remove .git to get a clean copy
    const repoUrl = templateRepo.includes("://")
      ? templateRepo
      : `https://github.com/${templateRepo}.git`;
    await execa("git", ["clone", "--depth", "1", repoUrl, targetPath], {
      stdio: "pipe",
    });
    await fs.remove(path.join(targetPath, ".git"));

    // Replace template placeholders in package.json
    const pkgPath = path.join(targetPath, "package.json");
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJSON(pkgPath);
      if (pkg.name) {
        pkg.name = projectName;
      }
      await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
    }

    // Create local database
    const dbName = projectName.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    await execa("createdb", [dbName], { stdio: "pipe" });

    // Initialize git repo
    await execa("git", ["init"], { cwd: targetPath });
    await execa("git", ["add", "."], { cwd: targetPath });
    await execa("git", ["commit", "-m", "Initial commit from template"], {
      cwd: targetPath,
    });
  }

  async setupGitHubRepo(options: SetupGitHubRepoOptions): Promise<string> {
    const { targetPath, repoName, org, isPrivate = true } = options;

    const fullName = org ? `${org}/${repoName}` : repoName;
    const args = ["repo", "create", fullName, "--source", targetPath];

    if (isPrivate) {
      args.push("--private");
    } else {
      args.push("--public");
    }

    args.push("--push");

    const result = await execa("gh", args, { cwd: targetPath });
    return result.stdout.trim();
  }

  async detectProjectStructure(
    projectPath: string,
  ): Promise<ProjectScaffoldResult> {
    const turboJsonPath = path.join(projectPath, "turbo.json");
    const isTurborepo = await fs.pathExists(turboJsonPath);

    let apps: string[] = [];

    if (isTurborepo) {
      const appsDir = path.join(projectPath, "apps");
      if (await fs.pathExists(appsDir)) {
        const entries = await fs.readdir(appsDir, { withFileTypes: true });
        apps = entries.filter(e => e.isDirectory()).map(e => e.name);
      }
    }

    return {
      path: projectPath,
      apps,
      type: isTurborepo ? "TURBOREPO" : "STANDARD",
    };
  }

  async inspectProject(projectPath: string): Promise<ProjectInspection> {
    if (!(await fs.pathExists(projectPath))) {
      throw new Error(`Path does not exist: ${projectPath}`);
    }

    const turboJsonPath = path.join(projectPath, "turbo.json");
    const isTurborepo = await fs.pathExists(turboJsonPath);
    if (!isTurborepo) {
      throw new Error(
        `Not a turborepo: turbo.json not found at ${projectPath}`,
      );
    }

    const rootPkgPath = path.join(projectPath, "package.json");
    let rootName: string | null = null;
    if (await fs.pathExists(rootPkgPath)) {
      const rootPkg = await fs.readJSON(rootPkgPath).catch(() => null);
      if (rootPkg?.name && typeof rootPkg.name === "string") {
        rootName = rootPkg.name;
      }
    }

    const apps: string[] = [];
    const devCommands: Record<string, string> = {};
    const appPorts: Record<string, number> = {};

    const appsDir = path.join(projectPath, "apps");
    if (await fs.pathExists(appsDir)) {
      const entries = await fs.readdir(appsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const appName = entry.name;
        const appPkgPath = path.join(appsDir, appName, "package.json");
        if (!(await fs.pathExists(appPkgPath))) continue;
        apps.push(appName);

        const appPkg = await fs.readJSON(appPkgPath).catch(() => null);
        const devScript = appPkg?.scripts?.dev;
        if (typeof devScript === "string" && devScript.trim()) {
          const port = extractPortFromScript(devScript);
          if (port !== null) appPorts[appName] = port;
          devCommands[appName] = stripPortFromScript(devScript);
        }
      }
    }

    let dbEnvVarName: string | null = null;
    const envExamplePath = path.join(projectPath, ".env.example");
    if (await fs.pathExists(envExamplePath)) {
      const content = await fs.readFile(envExamplePath, "utf8");
      dbEnvVarName = extractDbEnvVarName(content);
      for (const app of apps) {
        if (appPorts[app] !== undefined) continue;
        const port = extractPortFromEnvExample(content, app);
        if (port !== null) appPorts[app] = port;
      }
    }

    let dbDockerImage: string | null = null;
    for (const composeFile of ["docker-compose.yml", "docker-compose.yaml"]) {
      const composePath = path.join(projectPath, composeFile);
      if (!(await fs.pathExists(composePath))) continue;
      const content = await fs.readFile(composePath, "utf8");
      dbDockerImage = extractPostgresImage(content);
      if (dbDockerImage) break;
    }

    return {
      path: projectPath,
      name: rootName,
      type: "TURBOREPO",
      apps,
      devCommands,
      appPorts,
      dbEnvVarName,
      dbDockerImage,
      packageManager: await detectPackageManager(projectPath),
    };
  }
}
