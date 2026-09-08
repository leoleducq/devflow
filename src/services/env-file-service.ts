import { join, dirname } from "node:path";
import { readdir } from "node:fs/promises";
import fs from "fs-extra";

type EnvFileContext = {
  worktreePath: string;
  projectPath: string;
  databaseUrl: string;
  dbEnvVarName: string;
  ports: Record<string, number>;
  /**
   * The ports each app uses in the main checkout (`project.appPorts`). Every
   * `localhost:<original>` in the env files becomes the allocated port, so
   * `API_URL`, `NEXT_PUBLIC_API_URL`, CORS lists… all point at this
   * environment and it runs on its own ports with no proxy in front.
   */
  originalPorts?: Record<string, number>;
};

export class EnvFileService {
  async generateEnvFiles(context: EnvFileContext): Promise<void> {
    const envFiles = await this.findEnvFiles(context.projectPath);

    for (const relPath of envFiles) {
      const srcPath = join(context.projectPath, relPath);
      const destPath = join(context.worktreePath, relPath);

      let content = await fs.readFile(srcPath, "utf-8");

      // Replace the database URL env var
      const varName = context.dbEnvVarName;
      content = content.replace(
        new RegExp(`${varName}=.*`, "g"),
        `${varName}="${context.databaseUrl}"`,
      );

      content = this.rewriteLocalhostPorts(content, context);

      // Set PORT= to the allocated port for this app.
      for (const [appName, port] of Object.entries(context.ports)) {
        if (relPath === join("apps", appName, ".env")) {
          if (/^PORT=.*/m.test(content)) {
            content = content.replace(/^PORT=.*/m, `PORT=${port}`);
          } else {
            content = `PORT=${port}\n${content}`;
          }
        }
      }

      await fs.ensureDir(dirname(destPath));
      await fs.writeFile(destPath, content);
    }
  }

  /** `localhost:<original app port>` → `localhost:<allocated port>`. */
  private rewriteLocalhostPorts(
    content: string,
    context: EnvFileContext,
  ): string {
    for (const [appName, original] of Object.entries(
      context.originalPorts ?? {},
    )) {
      const allocated = context.ports[appName];
      if (!allocated || allocated === original) continue;
      content = content.replace(
        new RegExp(
          `(https?://(?:localhost|127\\.0\\.0\\.1)):${original}(?=[/"'\\s,]|$)`,
          // `m`: most values end the line, and `$` must match there.
          "gm",
        ),
        `$1:${allocated}`,
      );
    }
    return content;
  }

  /**
   * The main checkout's env files, verbatim: what a LITE environment gets so
   * agents can run tests and generators. It points at the main database and
   * ports, which is fine until the env is promoted and files are regenerated.
   */
  async copyEnvFiles(projectPath: string, worktreePath: string): Promise<void> {
    for (const relPath of await this.findEnvFiles(projectPath)) {
      const destPath = join(worktreePath, relPath);
      await fs.ensureDir(dirname(destPath));
      await fs.copy(join(projectPath, relPath), destPath);
    }
  }

  private async findEnvFiles(
    dir: string,
    base: string = dir,
  ): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".devflow"
      ) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const nested = await this.findEnvFiles(fullPath, base);
        results.push(...nested);
      } else if (entry.name === ".env") {
        results.push(fullPath.slice(base.length + 1));
      }
    }

    return results;
  }
}
