import { createApp } from "./app.js";
import { config } from "./config.js";
const { app } = await createApp({ logger: true });
await app.listen({ port: config.port, host: config.host });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
