import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT) || 51800;

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`Compass running at http://${info.address}:${info.port}`);
});
