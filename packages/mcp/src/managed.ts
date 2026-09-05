import {
  configuredProfiles,
  type RuntimeConnectionConfiguration,
} from "../../runtime/src/connectionProfiles.js";
import { startWorkbenchHttp } from "./http.js";

/** Private parent channel for desktop hosts. Credentials never enter arguments or project files. */
process.once(
  "message",
  async (configuration: {
    port: number;
    token: string;
    profiles: RuntimeConnectionConfiguration[];
    syntaxRuntimePath?: string;
  }) => {
    try {
      const secrets = [
        configuration.token,
        ...configuration.profiles.map((profile) => profile.identity.password),
      ].filter(Boolean);
      const service = await startWorkbenchHttp({
        ...configuration,
        profiles: configuredProfiles(configuration.profiles),
        redact: (message) =>
          secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), message),
      });
      let closing: Promise<void> | undefined;
      const close = () => {
        closing ??= service.close().finally(() => process.exit());
        return closing;
      };
      process.once("disconnect", close);
      process.once("SIGTERM", close);
      process.once("SIGINT", close);
      if (!process.connected) close();
      else process.send?.({ type: "ready", port: service.port });
    } catch (error) {
      process.send?.({
        type: "failed",
        message:
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? "The MCP port is already in use. Choose another port."
            : "MCP server could not start.",
      });
      process.exitCode = 1;
      process.disconnect?.();
    }
  },
);
