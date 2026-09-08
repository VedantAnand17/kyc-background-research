// Server entry. Wires config, logger, database, and the API app. PRD.md sections 5 and 13.
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/sqlite.js";
import { createLogger } from "./logger.js";
import { createApp } from "./api/routes.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const db = openDatabase(config.DATABASE_PATH);

const app = createApp({ config, db, log });

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log.info({ port: info.port, fixtureMode: config.FIXTURE_MODE }, "research api listening");
});
