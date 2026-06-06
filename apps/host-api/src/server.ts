import { buildApp } from "./create-app.js";

const port = Number(process.env.PORT ?? "4000");
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApp();

app
  .listen({ port, host })
  .then(() => {
    console.log(`Game VM Hub host API listening at http://${host}:${port}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

