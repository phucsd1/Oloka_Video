import { defineConfig } from "vite";

export default defineConfig({
  root: "tests/preview-compat",
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
});
