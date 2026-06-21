/**
 * Entrypoint. Boot the app, seed the Matchday, start the server, and run the
 * ingestion ticker (lock kicked-off matches, resolve finished ones). Everything
 * runs in one process; the ticker is the only background loop.
 */

import { createApp } from "./app.ts";
import { startServer } from "./api/server.ts";

const app = await createApp();
const { port } = app.config;

// Listen first so the platform health check passes immediately; loading the
// Matchday from the live feed must never block startup.
startServer(app, port);
console.log(`⚽ The Gaffer backend listening on :${port}`);
console.log(`   wiring:          ${JSON.stringify(app.wiring)}`);
console.log(`   Sessions wallet: ${app.engine.custody.sessionsAddress()}`);

const TICK_MS = 30_000;
const tick = async () => {
  try {
    await app.engine.tick();
  } catch (err) {
    console.error("[tick] failed:", err);
  }
};

app.engine
  .syncFixtures()
  .then(() => console.log(`   Matchday:        ${app.readModel.pots.openFixtures().length} fixtures open`))
  .catch((err) => console.error("[boot] syncFixtures failed:", err))
  .finally(() => setInterval(tick, TICK_MS));
