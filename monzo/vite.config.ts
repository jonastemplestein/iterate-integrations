import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack`: one ESM file and its declarations per source file, as the package ships
  pack: {
    entry: ["src/monzo.ts"],
    unbundle: true,
    platform: "neutral",
    dts: true,
    // its types come from iterate, which the project that installs this package has
    deps: { neverBundle: [/^iterate(\/|$)/] },
  },
});
