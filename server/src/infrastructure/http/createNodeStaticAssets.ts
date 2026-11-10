import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";

/** Node開発環境でbuild済みWeb UIとSPAのentryを配信する。 */
export const createNodeStaticAssets = () => {
  const root = fileURLToPath(new URL("../../../public/", import.meta.url));
  return {
    files: serveStatic({ root }),
    index: serveStatic({ root, path: "index.html" }),
  };
};
