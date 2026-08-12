import { defineConfig } from "vite";

export default defineConfig({
  root: "tests/preview-compat",
  plugins: [
    {
      name: "direct-preview-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (
            request.url !==
            "/api/v1/previews/00000000-0000-4000-8000-000000000001/content"
          ) {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader(
            "Content-Security-Policy",
            "sandbox allow-scripts; default-src 'none'; connect-src http://127.0.0.1:4178; style-src 'unsafe-inline'",
          );
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            `<!doctype html><html><body><output id="direct-preview-ready" data-csp="sandbox allow-scripts">ready</output><script>document.cookie='blocked=1'; localStorage.setItem('blocked','1');</script></body></html>`,
          );
        });
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/origin-probe") {
            next();
            return;
          }
          response.statusCode = 204;
          response.end();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
});
