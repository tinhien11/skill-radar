import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
