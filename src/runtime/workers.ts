import { createApp } from "../api/app.js";
import { workerEnvFromBindings } from "../api/env.js";

let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: Record<string, unknown>): Response | Promise<Response> {
    if (!app) {
      app = createApp(workerEnvFromBindings(env));
    }
    return app.fetch(request);
  },
};
