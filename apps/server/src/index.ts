import { buildApp } from "./app.js";

const { app } = await buildApp({ log: true });
const port = Number(process.env.PORT ?? 3101);
await app.listen({ port, host: "0.0.0.0" });

const shutdown = async () => {
  await app.close(); // disposes the ZEN engine
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
