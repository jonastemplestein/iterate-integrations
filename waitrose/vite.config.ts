import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack`: one ESM file and its declarations per source file, as the package ships
  pack: {
    entry: ["src/index.ts"],
    unbundle: true,
    platform: "neutral",
    dts: true,
  },
});
