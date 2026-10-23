import type { AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  options: ["Berlin", "Seoul", "Toronto"],
  form: undefined as Record<string, unknown> | undefined,
  tools: [] as Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;

    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      if (fakeAgentState.form) {
        const requestForm = this.tools.find((tool) => tool.name === "request_form");
        if (!requestForm) throw new Error("request_form tool missing");
        await requestForm.execute("call-form-1", fakeAgentState.form);
        return;
      }
      const askUser = this.tools.find((tool) => tool.name === "ask_user");
      if (!askUser) throw new Error("ask_user tool missing");
      await askUser.execute("call-choice-1", {
        question: "Which city should I use?",
        options: fakeAgentState.options,
      });
    }

    async waitForIdle() {}

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "choice-pi-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const choiceTool: ConnectorTool = {
  name: "ask_user",
  description: "Ask a short multiple-choice question",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["question", "options"],
  },
};

const formTool: ConnectorTool = {
  name: "request_form",
  description: "Ask the user to fill a form",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" }, fields: { type: "array" } },
    required: ["title", "fields"],
  },
};

const runContext = {
  operationId: "choice-pi",
  traceId: "choice-pi",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const runRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "ask me which city to use",
  instructions: "Use ask_user for a short list of options.",
  history: [],
  tools: [choiceTool],
  model: { provider: "test", id: "choice-pi-model" },
};

describe("Pi choice asks", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.options = ["Berlin", "Seoul", "Toronto"];
    fakeAgentState.form = undefined;
  });

  it("emits a tappable ask and stops without a finished-work fallback", async () => {
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual({
      type: "ask",
      text: "Which city should I use?",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
        { id: "choice-3", label: "Toronto" },
      ],
    });
    expect(
      events.some((event) => event.type === "text" && event.text.includes("I finished the work.")),
    ).toBe(false);
  });

  it("rejects an empty choice set before emitting an ask", async () => {
    fakeAgentState.options = [];
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow("ask_user requires two to four unique, non-empty options");
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  it("emits a form ask whose fields the user fills in", async () => {
    fakeAgentState.form = {
      title: "Dados da entrega",
      fields: [
        { label: " Nome ", type: "text" },
        { label: "E-mail", type: "email" },
      ],
    };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run({ ...runRequest, tools: [formTool] }, runContext))
      events.push(event);

    expect(events).toContainEqual({
      type: "ask",
      text: "Dados da entrega",
      fields: [
        { id: "field-1", label: "Nome", type: "text" },
        { id: "field-2", label: "E-mail", type: "email" },
      ],
    });
  });

  it("rejects a form field without a known type", async () => {
    fakeAgentState.form = {
      title: "Cartão",
      fields: [{ label: "Número do cartão", type: "card" }],
    };
    const runtime = new PiAgentRuntime();

    await expect(async () => {
      for await (const _event of runtime.run({ ...runRequest, tools: [formTool] }, runContext));
    }).rejects.toThrow("request_form requires one to eight fields with a label and a type");
  });
});
