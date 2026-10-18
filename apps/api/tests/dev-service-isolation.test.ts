import { mkdtemp, rm } from "node:fs/promises";
import * as files from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { PostgresSpaceStore } from "@space/db";
import { registerLiveRoutes } from "../src/live-routes.js";
import { InMemorySpaceStore } from "@space/runtime";
import { PluginsService } from "../src/plugins-service.js";
import { getAuthConfig } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { registerAuthRoutes } from "../src/auth-routes.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const path = String(args[0]);
      if (path.startsWith("/opt/spaceapp") || path.startsWith("/var/lib/spaceapp")) throw new Error("fixture refuses installed storage");
      return actual.mkdir(...args);
    }),
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).startsWith("/opt/spaceapp")) throw new Error("fixture refuses installed data reads");
      return actual.readFile(...args);
    }),
    writeFile: vi.fn(actual.writeFile)
  };
});

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("keeps default plugin persistence in the stack root and disables installed skill synchronization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-plugins-"));
  vi.stubEnv("SPACE_INSTANCE", "dev");
  vi.stubEnv("SPACE_PLUGINS_ROOT", directory);
  const service = new PluginsService();
  try {
    const plugins = await service.getPlugins();
    expect(plugins.length).toBeGreaterThan(0);
    await service.connectPlugin({ pluginId: "superpowers" });
    const saved = JSON.parse(await files.readFile(join(directory, "connections.json"), "utf8"));
    expect(saved.some((entry: { pluginId: string; status: string }) => entry.pluginId === "superpowers" && entry.status === "CONNECTED")).toBe(true);
    await service.syncSkillSymlinks();
    expect(vi.mocked(files.mkdir).mock.calls.every(([path]) => String(path).startsWith(directory))).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects disabled Google configuration before mutating credentials or touching installed files", async () => {
  const app = Fastify();
  const auth = getAuthConfig({ SPACE_GOOGLE_AUTH_DISABLED: "true" });
  app.addHook("preHandler", async (request) => {
    request.user = { id: "dev-admin", email: "admin@example.invalid", name: "Dev", role: "ADMIN" };
  });
  registerAuthRoutes(app, {
    config: getApiConfig({}), auth, store: new InMemorySpaceStore(), routeOptions: {},
  } as Parameters<typeof registerAuthRoutes>[1]);
  try {
    const response = await app.inject({ method: "POST", url: "/api/auth/google/configure", payload: { clientId: "fixture-client", clientSecret: "fixture-secret" } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("GOOGLE_AUTH_DISABLED");
    expect(auth.googleClientId).toBeUndefined();
    expect(auth.googleClientSecret).toBeUndefined();
    expect(files.mkdir).not.toHaveBeenCalled();
    expect(files.writeFile).not.toHaveBeenCalled();
  } finally { await app.close(); }
});


it("keeps live-history audit files private and never imports installed legacy history in dev", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-live-audit-"));
  vi.stubEnv("SPACE_LIVE_VOICE_LOG_ROOT", directory);
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.user = { id: "dev-admin", email: "admin@example.invalid", name: "Dev", role: "ADMIN" };
  });
  // Exercise the PostgreSQL-only file hooks without connecting to any database.
  // Undefined databaseUrl selects in-memory history repositories for this fixture.
  const store = Object.create(PostgresSpaceStore.prototype) as PostgresSpaceStore;
  registerLiveRoutes(app, {
    config: { ...getApiConfig({}), instance: "dev", installRoot: directory, databaseUrl: undefined },
    auth: getAuthConfig({ SPACE_GOOGLE_AUTH_DISABLED: "true" }), store, routeOptions: {},
    assertRoomAccess: async () => ({ id: "room:dev" }),
  } as Parameters<typeof registerLiveRoutes>[1]);
  try {
    const history = await app.inject({ url: "/api/live/history?roomId=room:dev" });
    expect(history.statusCode).toBe(200);
    expect(files.readFile).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url: "/api/voice/realtime/logs", payload: { roomId: "room:dev", event: "fixture" } });
    expect(response.statusCode).toBe(200);
    expect(vi.mocked(files.mkdir).mock.calls.some(([path]) => String(path).startsWith(directory))).toBe(true);
    expect(vi.mocked(files.mkdir).mock.calls.every(([path]) => String(path).startsWith(directory))).toBe(true);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
