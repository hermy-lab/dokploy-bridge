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
  allowedGithubOwner: string | undefined;
  allowedRepoNames: Set<string>;
  allowedDomainSuffixes: string[];
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
    allowedGithubOwner: process.env.ALLOWED_GITHUB_OWNER || undefined,
    allowedRepoNames: new Set(splitCsv(process.env.ALLOWED_REPO_NAMES)),
    allowedDomainSuffixes: splitCsv(process.env.ALLOWED_DOMAIN_SUFFIXES),
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

type DokployApplication = {
  applicationId: string;
  name?: string | null;
  appName?: string | null;
  environmentId?: string | null;
};

const getApplication = (appId: string) =>
  dokploy<DokployApplication>("GET", `/application.one?applicationId=${encodeURIComponent(appId)}`);

const assertAllowedManagedApp = (appId: string): Effect.Effect<DokployApplication, HttpError> => {
  if (config.allowedAppIds.has(appId)) return getApplication(appId);
  if (!config.allowedEnvironmentId) return Effect.fail(new HttpError(403, "App is not allowlisted"));

  return pipe(
    getApplication(appId),
    Effect.flatMap((app) => app.environmentId === config.allowedEnvironmentId
      ? Effect.succeed(app)
      : Effect.fail(new HttpError(403, "App is outside the allowed environment")))
  );
};

const assertAllowedGithubSource = (owner: string, repository: string): Effect.Effect<void, HttpError> => {
  if (config.allowedGithubOwner && owner !== config.allowedGithubOwner) {
    return Effect.fail(new HttpError(403, "GitHub owner is not allowlisted"));
  }
  if (config.allowedRepoNames.size > 0 && !config.allowedRepoNames.has(repository)) {
    return Effect.fail(new HttpError(403, "GitHub repository is not allowlisted"));
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    return Effect.fail(new HttpError(400, "Invalid GitHub owner or repository"));
  }
  return Effect.void;
};

const assertAllowedDomain = (host: string): Effect.Effect<void, HttpError> => {
  const normalized = host.toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(normalized)) {
    return Effect.fail(new HttpError(400, "Invalid domain host"));
  }
  if (config.allowedDomainSuffixes.length === 0) {
    return Effect.fail(new HttpError(403, "Domain creation is disabled"));
  }
  if (!config.allowedDomainSuffixes.some((suffix) => normalized.endsWith(suffix.toLowerCase()))) {
    return Effect.fail(new HttpError(403, "Domain suffix is not allowlisted"));
  }
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
      Effect.flatMap(() => getApplication(appStatusId))
    );
  }

  const appRedeployId = appIdFromPath(url.pathname, "/redeploy");
  if (req.method === "POST" && appRedeployId) {
    if (!config.allowRedeploy) return Effect.fail(new HttpError(403, "Redeploy is disabled"));
    return pipe(
      assertAllowedManagedApp(appRedeployId),
      Effect.flatMap(() => dokploy("POST", "/application.redeploy", {
        applicationId: appRedeployId,
        title: "Redeploy requested by Hermes bridge",
        description: "Restricted redeploy via dokploy-bridge",
      }))
    );
  }


  const appDeployId = appIdFromPath(url.pathname, "/deploy");
  if (req.method === "POST" && appDeployId) {
    if (!config.allowRedeploy) return Effect.fail(new HttpError(403, "Deploy is disabled"));
    return pipe(
      assertAllowedManagedApp(appDeployId),
      Effect.flatMap(() => dokploy("POST", "/application.deploy", {
        applicationId: appDeployId,
        title: "Deploy requested by Hermes bridge",
        description: "Restricted deploy via dokploy-bridge",
      }))
    );
  }

  const appGithubId = appIdFromPath(url.pathname, "/github");
  if (req.method === "POST" && appGithubId) {
    return pipe(
      assertAllowedManagedApp(appGithubId),
      Effect.flatMap(() => readJson(req)),
      Effect.flatMap((body) => {
        const input = body as { owner?: unknown; repository?: unknown; branch?: unknown; buildPath?: unknown; githubId?: unknown };
        if (typeof input.owner !== "string" || typeof input.repository !== "string") {
          return Effect.fail(new HttpError(400, "owner and repository are required"));
        }
        const branch = typeof input.branch === "string" ? input.branch : "main";
        const buildPath = typeof input.buildPath === "string" ? input.buildPath : "/";
        const githubId = typeof input.githubId === "string" ? input.githubId : null;
        return pipe(
          assertAllowedGithubSource(input.owner, input.repository),
          Effect.flatMap(() => dokploy("POST", "/application.saveGithubProvider", {
            applicationId: appGithubId,
            owner: input.owner,
            repository: input.repository,
            branch,
            buildPath,
            githubId,
            triggerType: "push",
            enableSubmodules: false,
            watchPaths: null,
          }))
        );
      })
    );
  }

  const appBuildTypeId = appIdFromPath(url.pathname, "/build-type");
  if (req.method === "POST" && appBuildTypeId) {
    return pipe(
      assertAllowedManagedApp(appBuildTypeId),
      Effect.flatMap(() => readJson(req)),
      Effect.flatMap((body) => {
        const input = body as { buildType?: unknown; publishDirectory?: unknown; isStaticSpa?: unknown };
        const buildType = typeof input.buildType === "string" ? input.buildType : "nixpacks";
        if (!["dockerfile", "heroku_buildpacks", "paketo_buildpacks", "nixpacks", "static", "railpack"].includes(buildType)) {
          return Effect.fail(new HttpError(400, "Unsupported buildType"));
        }
        return dokploy("POST", "/application.saveBuildType", {
          applicationId: appBuildTypeId,
          buildType,
          dockerfile: "Dockerfile",
          dockerContextPath: null,
          dockerBuildStage: null,
          herokuVersion: null,
          railpackVersion: null,
          publishDirectory: typeof input.publishDirectory === "string" ? input.publishDirectory : null,
          isStaticSpa: typeof input.isStaticSpa === "boolean" ? input.isStaticSpa : null,
        });
      })
    );
  }

  const appDomainId = appIdFromPath(url.pathname, "/domains");
  if (req.method === "POST" && appDomainId) {
    return pipe(
      assertAllowedManagedApp(appDomainId),
      Effect.flatMap(() => readJson(req)),
      Effect.flatMap((body) => {
        const input = body as { host?: unknown; port?: unknown; https?: unknown };
        if (typeof input.host !== "string") return Effect.fail(new HttpError(400, "host is required"));
        const host = input.host;
        const port = typeof input.port === "number" ? input.port : 3000;
        const https = typeof input.https === "boolean" ? input.https : true;
        return pipe(
          assertAllowedDomain(host),
          Effect.flatMap(() => dokploy("POST", "/domain.create", {
            host: host.toLowerCase(),
            path: "/",
            port,
            https,
            applicationId: appDomainId,
            certificateType: https ? "letsencrypt" : "none",
            customCertResolver: null,
            composeId: null,
            serviceName: null,
            domainType: "application",
            previewDeploymentId: null,
            internalPath: null,
            stripPath: false,
          }))
        );
      })
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
