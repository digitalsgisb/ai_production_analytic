import { z } from "zod";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  LANGFLOW_BASE_URL: z.string().url().default("http://langflow:7860"),
  LANGFLOW_FLOW_ID: z.string().min(1).default("mock-flow"),
  LANGFLOW_INPUT_COMPONENT_ID: z.string().trim().default(""),
  LANGFLOW_API_KEY: z.string().default(""),
  LANGFLOW_LIVE_PROGRESS: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  LANGFLOW_MOCK: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  LANGFLOW_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(600_000),
  MIGRATIONS_DIR: z.string().default("db/migrations"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = schema.parse(env);
  if (!config.LANGFLOW_MOCK && !config.LANGFLOW_API_KEY) {
    throw new Error("LANGFLOW_API_KEY is required when LANGFLOW_MOCK is false");
  }
  return {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    publicOrigin: new URL(config.PUBLIC_ORIGIN).origin,
    databaseUrl: config.DATABASE_URL,
    langflowBaseUrl: config.LANGFLOW_BASE_URL.replace(/\/$/, ""),
    langflowFlowId: config.LANGFLOW_FLOW_ID,
    langflowInputComponentId: config.LANGFLOW_INPUT_COMPONENT_ID,
    langflowApiKey: config.LANGFLOW_API_KEY,
    langflowLiveProgress: config.LANGFLOW_LIVE_PROGRESS,
    langflowMock: config.LANGFLOW_MOCK,
    sessionTtlHours: config.SESSION_TTL_HOURS,
    langflowTimeoutMs: config.LANGFLOW_TIMEOUT_MS,
    migrationsDir: config.MIGRATIONS_DIR,
    secureCookies: config.NODE_ENV === "production",
  };
}
