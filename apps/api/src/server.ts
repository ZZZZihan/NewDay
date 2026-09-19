import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp({ ...config, logger: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().then(() => process.exit(0)).catch((error: unknown) => {
      app.log.error(error);
      process.exit(1);
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
