import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of the installed package.
 *
 * The bundle lives at `dist/index.js` and the sources at `src/**`, both one
 * directory below the package root once resolved — `dist/` directly, and
 * `src/lib/` after the extra `..` below. Files shipped alongside the code
 * (SKILL.md, the migrations, the herdr scripts) are addressed from here so
 * they resolve the same whether DevFlow runs from npm or from a checkout.
 */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/lib -> src -> root, and dist -> root (the bundle collapses to dist/).
  return here.endsWith("dist") ? join(here, "..") : join(here, "..", "..");
}

/** The agent skill shipped with the package. */
export const skillPath = (): string =>
  join(packageRoot(), "skills", "devflow", "SKILL.md");
