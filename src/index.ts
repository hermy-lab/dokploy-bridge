import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { Effect, pipe } from "effect";

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

type Config = {
  port: number;
  dokployUrl: string;
  dokployApiKey: string;
  bridgeToken: string;
  allowedAppIds: Set<string>;
  allowedEnvironmentId: string | undefined;
  allowedServerId: string | undefined;
  allowCreate: boolean;
  allowStartStop: boolean;
  allowRedeploy: boolean;
};

const splitCsv = (value = "") =>
  value.split(",").map((item) => item.trim()).filter(Boolean);

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : ["1", "true", "yes", "on"].includes(value.toLowerCase());

const loadConfig = (): Config => {
  const dokployUrl = process.env.DOKPLOY_URL ?? "https://dok.saphi.dev";
  const dokployApiKey = process.env.DOKPLOY_API_KEY;
  const bridgeToken = process.env.BRIDGE_TOKEN;

  if (!dokployApiKey) throw new Error("DOKPLOY_API_KEY is required");
  if (!bridgeToken || bridgeToken.length < 24) throw new Error("BRIDGE_TOKEN is required and should be at least 24 chars");

  return {
    port: Number(process.env.PORT ?? "8787"),
    dokployUrl: dokployUrl.replace(/\/$/, ""),
    dokployApiKey,
    bridgeToken,
    allowedAppIds: new Set(splitCsv(process.env.ALLOWED_APP_IDS)),
    allowedEnvironmentId: process.env.ALLOWED_ENVIRONMENT_ID || undefined,
    allowedServerId: process.env.ALLOWED_SERVER_ID || undefined,
    allowCreate: bool(process.env.ALLOW_CREATE, false),
    allowStartStop: bool(process.env.ALLOW_START_STOP, false),
    allowRedeploy: bool(process.env.ALLOW_REDEPLOY, true),
  };
};

const config = loadConfig();

const readJson = (req: IncomingMessage): Effect.Effect<unknown, HttpError> =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return {};
      return JSON.parse(raw) as unknown;
    },
    catch: (error) => new HttpError(400, "Invalid JSON body", error),
  });

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
};

const requireAuth = (req: IncomingMessage): Effect.Effect<void, HttpError> => {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (token !== config.bridgeToken) return Effect.fail(new HttpError(401, "Unauthorized"));
  return Effect.void;
};

const assertAllowedApp = (appId: string): Effect.Effect<void, HttpError> => {
  if (!config.allowedAppIds.has(appId)) return Effect.fail(new HttpError(403, "App is not allowlisted"));
  return Effect.void;
};

const dokploy = <T>(method: "GET" | "POST", path: string, body?: unknown): Effect.Effect<T, HttpError> =>
  Effect.tryPromise({
    try: async () => {
      const init: RequestInit = {
        method,
        headers: {
          "content-type": "application/json",
          "x-api-key": config.dokployApiKey,
        },
      };
      if (method === "POST") init.body = JSON.stringify(body ?? {});

      const response = await fetch(`${config.dokployUrl}/api${path}`, init);

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) throw new HttpError(response.status, "Dokploy request failed", data);
      return data as T;
    },
    catch: (error) => error instanceof HttpError ? error : new HttpError(502, "Dokploy request failed", error),
  });

const appIdFromPath = (pathname: string, suffix: string) => {
  const match = pathname.match(new RegExp(`^/apps/([^/]+)${suffix}$`));
  return match?.[1];
};

const routeAuthed = (req: IncomingMessage): Effect.Effect<unknown, HttpError> => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return Effect.succeed({ ok: true, dokployUrl: config.dokployUrl });
  }

  if (req.method === "GET" && url.pathname === "/projects") {
    return dokploy("GET", "/project.all");
  }

  if (req.method === "GET" && url.pathname === "/deployments") {
    return dokploy("GET", "/deployment.all");
  }

  const appStatusId = appIdFromPath(url.pathname, "");
  if (req.method === "GET" && appStatusId) {
    return pipe(
      assertAllowedApp(appStatusId),
      Effect.flatMap(() => dokploy("GET", `/application.one?applicationId=${encodeURIComponent(appStatusId)}`))
    );
  }

  const appRedeployId = appIdFromPath(url.pathname, "/redeploy");
  if (req.method === "POST" && appRedeployId) {
    if (!config.allowRedeploy) return Effect.fail(new HttpError(403, "Redeploy is disabled"));
    return pipe(
      assertAllowedApp(appRedeployId),
      Effect.flatMap(() => dokploy("POST", "/application.redeploy", {
        applicationId: appRedeployId,
        title: "Redeploy requested by Hermes bridge",
        description: "Restricted redeploy via dokploy-bridge",
      }))
    );
  }

  const appStartId = appIdFromPath(url.pathname, "/start");
  if (req.method === "POST" && appStartId) {
    if (!config.allowStartStop) return Effect.fail(new HttpError(403, "Start/stop is disabled"));
    return pipe(
      assertAllowedApp(appStartId),
      Effect.flatMap(() => dokploy("POST", "/application.start", { applicationId: appStartId }))
    );
  }

  const appStopId = appIdFromPath(url.pathname, "/stop");
  if (req.method === "POST" && appStopId) {
    if (!config.allowStartStop) return Effect.fail(new HttpError(403, "Start/stop is disabled"));
    return pipe(
      assertAllowedApp(appStopId),
      Effect.flatMap(() => dokploy("POST", "/application.stop", { applicationId: appStopId }))
    );
  }

  if (req.method === "POST" && url.pathname === "/apps") {
    if (!config.allowCreate) return Effect.fail(new HttpError(403, "Create app is disabled"));
    if (!config.allowedEnvironmentId) return Effect.fail(new HttpError(500, "ALLOWED_ENVIRONMENT_ID is required for app creation"));

    return pipe(
      readJson(req),
      Effect.flatMap((body) => {
        const input = body as { name?: unknown; appName?: unknown; description?: unknown };
        if (typeof input.name !== "string" || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(input.name)) {
          return Effect.fail(new HttpError(400, "name must be lowercase kebab-case, 2-49 chars"));
        }
        return dokploy("POST", "/application.create", {
          name: input.name,
          appName: typeof input.appName === "string" ? input.appName : input.name,
          description: typeof input.description === "string" ? input.description : "Created by Hermes via restricted bridge",
          environmentId: config.allowedEnvironmentId,
          serverId: config.allowedServerId ?? null,
        });
      })
    );
  }

  return Effect.fail(new HttpError(404, "Not found or intentionally blocked"));
};

const route = (req: IncomingMessage): Effect.Effect<unknown, HttpError> =>
  pipe(
    requireAuth(req),
    Effect.flatMap(() => routeAuthed(req))
  );

const server = createServer((req, res) => {
  Effect.runPromise(Effect.either(route(req))).then(
    (result) => {
      if (result._tag === "Left") {
        const err = result.left;
        sendJson(res, err.status, { error: err.message, details: err.details ?? undefined });
        return;
      }
      sendJson(res, 200, result.right);
    },
    (error) => {
      sendJson(res, 500, { error: "Internal error", details: String(error) });
    }
  );
});

server.listen(config.port, () => {
  console.log(`dokploy-bridge listening on :${config.port}`);
});
