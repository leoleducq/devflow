import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  // The Prisma client is generated at install time into prisma/generated,
  // so it must stay an external require rather than be inlined here.
  external: ["@prisma/client"],
  banner: { js: "#!/usr/bin/env node" },
});
