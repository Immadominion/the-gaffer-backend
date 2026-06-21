/**
 * Entrypoint. Boot the app, seed the Matchday, start the server, and run the
 * ingestion ticker (lock kicked-off matches, resolve finished ones). Everything
 * runs in one process; the ticker is the only background loop.
 */

import { createApp } from "./app.ts";
import { startServer } from "./api/server.ts";

const app = await createApp();
await app.engine.syncFixtures();

const { port } = app.config;
startServer(app, port);

console.log(`⚽ The Gaffer backend listening on :${port}`);
console.log(`   wiring:          ${JSON.stringify(app.wiring)}`);
console.log(`   Sessions wallet: ${app.engine.custody.sessionsAddress()}`);
console.log(`   Matchday:        ${app.readModel.pots.openFixtures().length} fixtures open`);

const TICK_MS = 30_000;
const tick = async () => {
  try {
    await app.engine.tick();
  } catch (err) {
    console.error("[tick] failed:", err);
  }
};
setInterval(tick, TICK_MS);
