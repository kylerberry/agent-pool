import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TelemetryCollector, resolveAssociation, telemetryStatus } from "./core.mjs";

function modelId(ctx: ExtensionContext): string | null {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
}

export default function evalTelemetryExtension(pi: ExtensionAPI) {
  let collector: TelemetryCollector | null = null;
  let lastStatus: Record<string, unknown> = { associated: false, reason: "session_not_started" };

  const safely = (operation: () => void) => {
    try { operation(); }
    catch (error) {
      lastStatus = {
        associated: Boolean(collector),
        reason: "telemetry_callback_error",
        error_code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "telemetry_error",
      };
    }
  };

  pi.on("session_start", (_event, ctx) => {
    safely(() => {
      const association = resolveAssociation(ctx.cwd, process.env);
      if (!association.associated) {
        collector = null;
        lastStatus = association;
        return;
      }
      collector = new TelemetryCollector({
        rootDir: ctx.cwd,
        association,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        model: modelId(ctx),
        activeTools: pi.getActiveTools(),
      });
      lastStatus = collector.status();
    });
  });

  pi.on("before_agent_start", (event, ctx) => {
    safely(() => {
      collector?.capturePrompt(event.prompt, event.systemPrompt, pi.getActiveTools());
      if (collector) lastStatus = collector.status();
    });
  });

  pi.on("turn_start", () => safely(() => collector?.turnStarted()));

  pi.on("message_end", (event) => {
    safely(() => {
      if (event.message.role === "assistant") collector?.captureAssistant(event.message);
      if (collector) lastStatus = collector.status();
    });
  });

  pi.on("tool_execution_start", (event) => safely(() => collector?.toolStarted(event.toolCallId, event.toolName)));
  pi.on("tool_execution_end", (event) => safely(() => collector?.toolEnded(event.toolCallId, event.toolName, event.isError)));

  pi.on("agent_settled", () => {
    safely(() => {
      collector?.finalize("agent_settled");
      if (collector) lastStatus = collector.status();
    });
  });

  pi.on("session_shutdown", () => {
    safely(() => {
      collector?.finalize("session_shutdown");
      if (collector) lastStatus = collector.status();
    });
  });

  pi.registerCommand("eval-telemetry-status", {
    description: "Show privacy-safe local build telemetry coverage and health",
    handler: async (_args, ctx) => {
      const status = collector?.status() ?? telemetryStatus(ctx.cwd, process.env) ?? lastStatus;
      const text = JSON.stringify(status, null, 2);
      if (ctx.hasUI) ctx.ui.notify(text, status.associated ? "info" : "warning");
      else console.log(text);
    },
  });
}
