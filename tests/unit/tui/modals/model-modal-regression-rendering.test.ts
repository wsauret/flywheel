import { describe, expect, test } from "bun:test";
import { modelAssignmentText, modelLabelColumn, modelText, providerChainText } from "../../../../src/tui/modals/model-modal-text.js";
import { contextLine } from "../../../../src/tui/modals/model-modal-chrome.js";
import { displayWidth } from "../../../../src/tui/utils/text.js";
import { styledTextContent, theme } from "./_model-modal-fixtures";
import type { ModelOptionRow } from "../../../../src/protocol/model-assignment-protocol-types.js";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { createSignal } from "solid-js";
import { ScrollBoxRenderable, TextAttributes, TextRenderable, type Renderable } from "@opentui/core";
import type { ModelModalState } from "../../../../src/tui/modals/model-modal-types.js";

test("catalog publication keeps model renderables and the top visible model after insertion", async () => {
  const [{ testRender }, { createComponent }, { ThemeProvider }, { ModelModal }] = await Promise.all([
    import("@opentui/solid"), import("solid-js/web"),
    import("../../../../src/tui/context/theme.js"), import("../../../../src/tui/modals/model-modal.js"),
  ]);
  const options: ModelOptionRow[] = Array.from({ length: 284 }, (_, index) => ({
    slot: roleSlot("chat"), model: `model-${index}`, label: `model-${index}`,
    selectable: true, efforts: ["low", "high"], effort: "high",
    providers: index === 12
      ? [{ name: "Copilot", shortName: "Copilot", serving: false }, { name: "Anthropic API", shortName: "Anthropic", serving: true }]
      : [{ name: "ChatGPT", shortName: "ChatGPT", serving: false }],
  }));
  const [state, setState] = createSignal<ModelModalState>({
    view: { kind: "models" }, scope: "defaults", scopeToggleAvailable: false,
    assignmentItems: [], modelOptions: options,
    query: "model", pendingEfforts: new Map(), cursor: 12, loading: false, confirmReset: false,
  });
  const selections: number[] = [];
  const result = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() { return createComponent(ModelModal, { get state() { return state(); }, onClose() {}, onSelect(index) { selections.push(index); } }); },
  }), { width: 90, height: 28 });
  const nodes = (): Renderable[] => {
    const all: Renderable[] = [result.renderer.root];
    for (let i = 0; i < all.length; i++) all.push(...all[i]!.getChildren());
    return all;
  };
  try {
    await result.renderOnce();
    expect(result.captureCharFrame()).toContain("Providers: Copilot → Anthropic API");
    const initialFrame = result.captureCharFrame();
    expect(initialFrame).toContain("Search: model");
    expect(initialFrame.indexOf("Providers:")).toBeGreaterThan(initialFrame.indexOf("Cached input"));
    expect(initialFrame.indexOf("Providers:")).toBeLessThan(initialFrame.indexOf("↑↓ select"));
    const providerText = nodes().find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.startsWith("Providers:"))!;
    const footerText = nodes().find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.includes("bksp edit"))!;
    const providerChunk = (text: string) => providerText.content.chunks.find((chunk) => chunk.text === text)!;
    expect(providerChunk("Copilot").fg).toEqual(footerText.fg);
    expect(providerChunk("Anthropic API").fg).not.toEqual(footerText.fg);
    expect(providerText.attributes).toBe(0);
    const writes = new Set<TextRenderable>();
    for (const node of nodes()) {
      if (!(node instanceof TextRenderable)) continue;
      let prototype = Object.getPrototypeOf(node);
      let descriptor: PropertyDescriptor | undefined;
      while (prototype && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, "content");
        prototype = Object.getPrototypeOf(prototype);
      }
      if (!descriptor?.set) throw new Error("TextRenderable has no content setter");
      const content = descriptor;
      Object.defineProperty(node, "content", {
        configurable: true,
        get: () => content.get?.call(node),
        set: (value) => { writes.add(node); content.set?.call(node, value); },
      });
    }
    setState((previous) => ({ ...previous, cursor: 13 }));
    await result.renderOnce();
    expect(result.captureCharFrame()).toContain("Providers: ChatGPT");
    expect(result.captureCharFrame()).not.toContain("Copilot → Anthropic API");
    expect([...writes].filter((node) => node.plainText.includes("model-"))).toHaveLength(2);
    setState((previous) => ({ ...previous, cursor: 12 }));
    await result.renderOnce();
    const before = nodes().find((node) => node instanceof TextRenderable && node.plainText.includes("model-12"));
    const scroll = nodes().find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)!;
    scroll.scrollTo(8);
    await result.renderOnce();
    const top = scroll.scrollTop;
    setState((previous) => ({ ...previous, cursor: 13, modelOptions: [{ ...options[0]!, model: "new-model", label: "new-model" }, ...options.map((option) => ({ ...option }))] }));
    await result.renderOnce();
    expect(nodes().find((node) => node instanceof TextRenderable && node.plainText.includes("model-12")) === before).toBe(true);
    expect(scroll.scrollTop).toBe(top + 1);
    expect(result.captureCharFrame()).toContain("Search: model");
    expect(result.captureCharFrame()).not.toContain("Loading");
    const lines = result.captureCharFrame().split("\n");
    const line = lines.findIndex((value) => value.includes("model-12"));
    await result.mockMouse.click(lines[line]!.indexOf("model-12"), line);
    expect(selections).toEqual([13]);
    setState((previous) => ({
      ...previous, cursor: 33,
      modelOptions: [...previous.modelOptions.slice(0, 10),
        ...Array.from({ length: 20 }, (_, index) => ({ ...options[0]!, model: `insert-${index}`, label: `insert-${index}` })),
        ...previous.modelOptions.slice(10)],
    }));
    await result.renderOnce();
    expect(result.captureCharFrame()).toContain("model-12");
    expect(scroll.scrollTop).toBe(33 - scroll.viewport.height + 1);
    setState((previous) => ({ ...previous, cursor: 32, modelOptions: previous.modelOptions.filter((row) => row.model !== "model-12") }));
    await result.renderOnce();
    expect(nodes().includes(before!)).toBe(false);
    expect(result.captureCharFrame()).toContain("model-11");
    result.resize(40, 24);
    setState((previous) => ({
      ...previous, scope: "session", scopeToggleAvailable: true, cursor: previous.modelOptions.length - 1,
      pendingEfforts: new Map([["model-283", "low"]]),
      modelOptions: previous.modelOptions.map((row) => ({
        ...row,
        current: row.model === "model-283",
        roleDefault: row.model === "model-283",
        cost: { input: 1, output: 5 },
        providers: ["ChatGPT Subscription", "GitHub Copilot", "OpenAI API Key", "OpenRouter", "DeepSeek API"].map((name) => ({ name, shortName: name, serving: false })),
      })),
    }));
    await result.renderOnce();
    await Bun.sleep(0);
    await result.renderOnce();
    const wrappedFrame = result.captureCharFrame();
    expect(wrappedFrame).toMatch(/> model-283\s+Low/);
    expect(wrappedFrame).toContain("Providers: ChatGPT Subscription");
    expect(wrappedFrame).toContain("DeepSeek API");
    expect(wrappedFrame).toContain("Input");
    expect(wrappedFrame).toContain("$1 / 1M");
    const narrowLines = wrappedFrame.split("\n");
    const providerLines = narrowLines.filter((frameLine) => /Providers:|→|Key →/.test(frameLine) && !frameLine.includes("←→"));
    expect(providerLines.map((providerLine) => providerLine.replaceAll("│", "").trim()).join(" ").replace(/\s+/g, " "))
      .toContain("Providers: ChatGPT Subscription → GitHub Copilot → OpenAI API Key → OpenRouter → DeepSeek API");
    const lastRow = narrowLines.findIndex((frameLine) => frameLine.includes("> model-283"));
    await result.mockMouse.click(narrowLines[lastRow]!.indexOf("model-283"), lastRow);
    expect(selections.at(-1)).toBe(state().modelOptions.length - 1);
    setState((previous) => ({
      ...previous, query: "model-283", modelOptions: previous.modelOptions.filter((row) => row.model === "model-283"), cursor: 0,
    }));
    await result.renderOnce();
    expect(result.captureCharFrame()).toContain("Search: model-283");
    expect(result.captureCharFrame()).toMatch(/> model-283\s+Low/);
    setState((previous) => ({ ...previous, query: "missing", modelOptions: [], cursor: 0 }));
    await result.renderOnce();
    const emptyFrame = result.captureCharFrame();
    expect(emptyFrame).toContain("No matching models.");
    for (const frame of [wrappedFrame, emptyFrame]) {
      for (const shortcut of ["ctrl+g scope", "enter confirm", "←→ effort", "↑↓", "home/end ends", "pgup/pgdn page", "bksp edit", "esc close"]) {
        expect(frame).toContain(shortcut);
      }
    }
  } finally { result.renderer.destroy(); }
});
describe("model modal rendering structure", () => {
  test("assignment context does not label the inheritance glyph", () => {
    expect(contextLine({
      view: { kind: "assignments" },
      scope: "session",
      scopeToggleAvailable: true,
      assignmentItems: [],
      modelOptions: [],
      query: "",
      pendingEfforts: new Map(),
      cursor: 0,
      loading: false,
      confirmReset: false,
    })).toBe("Changes apply to this tab only.");
  });

  test("workflow picker chrome names profile scope and keeps the broken setting outside choices", () => {
    expect(contextLine({
      view: { kind: "models" }, scope: "session", profileOwned: true, savedModel: "lost-model",
      scopeToggleAvailable: false, assignmentItems: [], modelOptions: [],
      query: "", pendingEfforts: new Map(), cursor: 0, loading: false, confirmReset: false,
    })).toBe("Changes apply to this auth profile. Saved: lost-model");
  });

  test("assignments show only the glyph when their pair matches inheritance", () => {
    const matchingPair = {
      slot: roleSlot("reviewer-design"),
      label: "Design",
      model: "gpt-6.1-sol",
      effort: "low",
      modelSource: "explicit",
      matchesInheritedPair: true,
    } as const;
    const content = styledTextContent(modelAssignmentText(matchingPair, false, theme, 12, 32));

    expect(content).toContain("gpt-6.1-sol Low ↳");
    expect(content).not.toContain("inherited");
    expect(displayWidth(content)).toBeLessThanOrEqual(32);
  });

  test("assignments show no indicator when either value differs", () => {
    const differentPair = {
      slot: roleSlot("reviewer-design"),
      label: "Design",
      model: "gpt-6.1-sol",
      effort: "low",
      modelSource: "inherited",
      matchesInheritedPair: false,
    } as const;
    const content = styledTextContent(modelAssignmentText(differentPair, false, theme, 12, 32));

    expect(content).toEndWith("gpt-6.1-sol Low");
    expect(content).not.toContain("↳");
    expect(content).not.toContain("pinned");
    expect(content).not.toContain("default");
  });

  test("reviewer subtype picker shows the inherited model and effort", () => {
    const row: ModelOptionRow = {
      slot: roleSlot("reviewer-design"),
      model: null,
      label: "Inherit Reviewer",
      inheritModel: "gpt-6.1-sol",
      efforts: ["low", "medium"],
      effort: "low",
      selectable: true,
      inherit: true,
      current: true,
      providers: [],
    };
    const content = styledTextContent(modelText(row, false, theme, 80));

    expect(content).toContain("Inherit Reviewer");
    expect(content).toContain("gpt-6.1-sol");
    expect(content).toMatch(/■+\s+Low/);
    const compact = modelText(row, true, theme, 26);
    expect(styledTextContent(compact)).toContain("Inherit Reviewer");
    expect(styledTextContent(compact)).toContain("Low");
    expect(displayWidth(styledTextContent(compact))).toBeLessThanOrEqual(26);
    expect(compact.chunks.find((chunk) => chunk.text.includes("Inherit"))?.fg).toEqual(theme.primary);
    expect(compact.chunks.find((chunk) => chunk.text.includes("Low"))?.fg).toEqual(theme.textMuted);
  });

  test("renders the query-owned free label without provider identity", () => {
    const text = styledTextContent(modelText({
      slot: roleSlot("chat"),
      model: "minimax-m2.5-free",
      label: "minimax-m2.5",
      selectable: true,
      current: false,
      tier: "cheap",
      efforts: ["low", "medium"],
      effort: "medium",
      cost: { input: 0.2, output: 1 },
      providers: [],
    }, false, theme, 80));
    expect(text).toContain("minimax-m2.5");
    expect(text).not.toContain("OpenCode Go");
  });

  test("model rows render the selected effort as an inline meter and label", () => {
    const text = modelText({
      slot: roleSlot("chat"),
      model: "gpt-6.1-sol",
      label: "gpt-6.1-sol",
      selectable: true,
      efforts: ["low", "medium", "high", "xhigh"],
      effort: "high",
      providers: [],
    }, false, theme, 52);

    expect(styledTextContent(text)).toMatch(/■■■■\s+High/);
    expect(text.chunks.filter((chunk) => chunk.text.includes("■"))).toHaveLength(2);
  });

  test("model rows render all six reasoning cells and the Ultra label", () => {
    const text = modelText({
      slot: roleSlot("chat"),
      model: "gpt-6-sol",
      label: "gpt-6-sol",
      selectable: true,
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      effort: "ultra",
      providers: [],
    }, false, theme, 52);
    expect(styledTextContent(text)).toMatch(/■■■■■■\s+Ultra/);
  });

  test("tagged and untagged rows keep one meter column when long labels must truncate", () => {
    const rows: ModelOptionRow[] = [
      { slot: roleSlot("chat"), model: "a-very-long-model-identifier-that-overflows", label: "a-very-long-model-identifier-that-overflows", selectable: true, efforts: ["low", "medium", "high"], effort: "medium", providers: [] },
      { slot: roleSlot("chat"), model: "gpt-6.1-sol", label: "gpt-6.1-sol", selectable: true, roleDefault: true, current: true, efforts: ["low", "medium", "high"], effort: "high", providers: [] },
    ];
    const column = modelLabelColumn(rows);
    const rendered = rows.map((row) => styledTextContent(modelText(row, false, theme, 48, column)));

    expect(new Set(rendered.map((text) => text.indexOf("■"))).size).toBe(1);
    expect(rendered[0]!.indexOf("■")).toBe(18);
    expect(rendered[1]).toEndWith("High   default current");
    for (const text of rendered) expect(displayWidth(text)).toBeLessThanOrEqual(48);
    const compact = modelText(rows[1]!, true, theme, 26, column, "low");
    expect(styledTextContent(compact)).toMatch(/^> gpt-6\.1-sol\s+Low   $/);
    expect(displayWidth(styledTextContent(compact))).toBe(26);
    expect(compact.chunks.find((chunk) => chunk.text === "gpt-6.1-sol")?.fg).toEqual(theme.text);
    expect(compact.chunks.find((chunk) => chunk.text.includes("Low"))?.fg).toEqual(theme.primary);
  });

  test("an unavailable reason does not hide model names across the picker", () => {
    const rows: ModelOptionRow[] = [
      { slot: roleSlot("chat"), model: "gpt-6.1-sol", label: "gpt-6.1-sol", selectable: true, efforts: ["low", "medium", "high"], effort: "medium", providers: [] },
      {
        slot: roleSlot("chat"),
        model: "gpt-5.4",
        label: "gpt-5.4",
        selectable: false,
        current: true,
        roleDefault: true,
        reason: "not available from any enabled provider; configure it in /auth",
        efforts: ["low", "medium", "high"],
        effort: "medium",
        providers: [],
      },
    ];
    const column = modelLabelColumn(rows);
    const rendered = rows.map((row) => styledTextContent(modelText(row, false, theme, 52, column)));

    expect(rendered[0]).toContain("gpt-6.1-sol");
    expect(rendered[1]).toContain("gpt-5.4");
    expect(rendered[1]).toContain("not available");
    for (const text of rendered) expect(displayWidth(text)).toBeLessThanOrEqual(52);
    const compact = modelText(rows[1]!, true, theme, 26, column);
    expect(styledTextContent(compact)).toContain("gpt-5.4");
    expect(styledTextContent(compact)).toContain("not avai");
    expect(styledTextContent(compact)).not.toContain("Medium");
    expect(displayWidth(styledTextContent(compact))).toBeLessThanOrEqual(26);
    expect(compact.chunks.find((chunk) => chunk.text === "gpt-5.4")?.fg).toEqual(theme.textMuted);
    expect(compact.chunks.find((chunk) => chunk.text.includes("not avai"))?.fg).toEqual(theme.warning);
  });

  test("Chat uses a bold heading label and retains its aligned model and selection", () => {
    const row = {
      slot: roleSlot("chat"),
      label: "Chat",
      model: "claude-sonnet-4.5",
      effort: "low",
      modelSource: "explicit",
      matchesInheritedPair: false,
    } as const;
    const text = modelAssignmentText(row, true, theme, 12, 52, "heading");
    const content = styledTextContent(text);

    expect(content.length).toBeLessThanOrEqual(52);
    expect(content).toStartWith(">Chat");
    expect(text.chunks[1]!.attributes! & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(text.chunks[0]!.fg).toEqual(theme.primary);
    const persona = styledTextContent(modelAssignmentText({ ...row, slot: roleSlot("explorer"), label: "Explorer" }, false, theme, 12, 52));
    expect(content.indexOf("claude-sonnet-4.5")).toBe(persona.indexOf("claude-sonnet-4.5"));
    expect(styledTextContent(modelAssignmentText(row, false, theme, 12, 52, "heading"))).toStartWith(" Chat");
    expect(content).toContain("claude-sonnet-4.5");
    expect(content).toContain("Low");
  });

  test("assignment labels truncate on grapheme and terminal-column boundaries", () => {
    const content = styledTextContent(modelAssignmentText({
      slot: roleSlot("explorer"),
      label: "審査🚀 Implementation Spec",
      model: "gpt-6.1-sol",
      effort: "medium",
      modelSource: "inherited",
      matchesInheritedPair: true,
    }, false, theme, 26, 48));

    expect(content).toBe("  審査🚀 Implementation ... gpt-6.1-sol Medium ↳");
    expect(displayWidth(content)).toBe(48);
  });

  test("unresolved assignment rows wait for scoped auth before naming a missing provider", () => {
    const content = styledTextContent(modelAssignmentText({
      slot: roleSlot("chat"),
      label: "Chat",
      model: "powerful",
      effort: "medium",
      modelSource: "default",
      matchesInheritedPair: true,
    }, false, theme, 12, 52));

    expect(content).toContain("checking provider models");
    expect(content).not.toContain("powerful");
    expect(content).not.toContain("medium");
    expect(content).not.toContain("default");
  });

  test("configured auth with unsettled discovery never renders as disconnected", () => {
    const content = styledTextContent(modelAssignmentText({
      slot: roleSlot("chat"), label: "Chat", model: "powerful", effort: "medium",
      modelSource: "default",
      matchesInheritedPair: true,
    }, false, theme, 12, 52, "heading", {
      providers: [{
        providerId: "chatgpt", kind: "subscription", source: "oauth", expired: false,
        configured: true, modelCapable: true, loginMethod: "browser-auth", statusRank: 10,
        group: "model", accounts: [], displayName: "ChatGPT",
      }],
      warnings: [],
      profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [] },
      subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
    }));

    expect(content).toContain("checking provider models");
    expect(content).not.toContain("no provider connected");
  });

  test("the provider chain names every provider in full and shows only the serving one in the accent color", () => {
    const chunks = (serving: string | undefined) => providerChainText(
      ["ChatGPT Subscription", "OpenAI API Key"].map((name) => ({ name, shortName: name, serving: name === serving })), theme,
    ).chunks;
    expect(chunks("OpenAI API Key").map((chunk) => chunk.text).join("")).toBe("Providers: ChatGPT Subscription → OpenAI API Key");
    expect(chunks("OpenAI API Key").map((chunk) => [chunk.text, chunk.fg])).toEqual([
      ["Providers: ", theme.textMuted], ["ChatGPT Subscription", theme.textMuted], [" → ", theme.textMuted], ["OpenAI API Key", theme.accent],
    ]);
    expect(chunks(undefined).every((chunk) => chunk.fg === theme.textMuted)).toBe(true);
    expect(providerChainText([], theme).chunks.map((chunk) => [chunk.text, chunk.fg])).toEqual([["Providers: None available", theme.textMuted]]);
  });

  test("picker rows omit catalog provenance from labels and width", () => {
    const base: ModelOptionRow = {
      slot: roleSlot("chat"), model: "gpt-5.5", label: "gpt-5.5", selectable: true,
      efforts: ["low", "medium"], effort: "medium", providers: [],
    };
    for (const catalogProvenance of ["first-party", "models-dev-live", "models-dev-archive", "models-dev-bundled", "static"] as const) {
      const content = styledTextContent(modelText({ ...base, catalogProvenance }, false, theme, 64));
      expect(content).toBe(styledTextContent(modelText(base, false, theme, 64)));
      expect(modelLabelColumn([{ ...base, catalogProvenance }])).toEqual(modelLabelColumn([base]));
      expect(content.length).toBeLessThanOrEqual(64);
    }
  });

  test("anthropic model rows show the canonical model identity and no provider label", () => {
    const content = styledTextContent(modelText({
      slot: roleSlot("chat"),
      model: "claude-opus-4.1",
      label: "claude-opus-4.1",
      selectable: true,
      efforts: ["low", "medium", "high"],
      effort: "medium",
      cost: { input: 36, output: 180 },
      providers: [],
    }, false, theme, 52));

    expect(content.length).toBeLessThanOrEqual(52);
    expect(content).toContain("claude-opus-4.1");
    expect(content).not.toContain("Anthropic");
    expect(content).not.toContain("$36/1M input");
  });

  test("the role default model row is labeled default", () => {
    const content = styledTextContent(modelText({
      slot: roleSlot("reviewer"),
      model: "gpt-6-luna",
      label: "gpt-6-luna",
      selectable: true,
      roleDefault: true,
      efforts: ["low", "medium"],
      effort: "medium",
      providers: [],
    }, false, theme, 52));

    expect(content).toContain("gpt-6-luna");
    expect(content).toContain("default");
  });

});
