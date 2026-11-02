const installWidgets = document.querySelectorAll<HTMLElement>(".install");

for (const widget of installWidgets) {
  const tabs = [...widget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

  const select = (tab: HTMLButtonElement, focus: boolean) => {
    for (const candidate of tabs) {
      const panelId = candidate.getAttribute("aria-controls");
      const panel = panelId === null ? null : document.getElementById(panelId);
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      if (panel instanceof HTMLElement) panel.hidden = !selected;
    }
    if (focus) tab.focus();
  };

  // The server renders every platform command visible so the page reads
  // without JavaScript; enhancement collapses them into one tabbed row.
  const initial = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
  if (initial !== undefined) select(initial, false);

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (event) => {
      const target =
        event.key === "ArrowRight"
          ? tabs[(index + 1) % tabs.length]
          : event.key === "ArrowLeft"
            ? tabs[(index - 1 + tabs.length) % tabs.length]
            : event.key === "Home"
              ? tabs[0]
              : event.key === "End"
                ? tabs[tabs.length - 1]
                : undefined;
      if (target === undefined) return;
      event.preventDefault();
      select(target, true);
    });
  });

  const status = widget.querySelector<HTMLElement>(".copy-status");
  for (const button of widget.querySelectorAll<HTMLButtonElement>(".copy-btn")) {
    button.addEventListener("click", async () => {
      const code = button.closest('[role="tabpanel"]')?.querySelector("code");
      if (code === null || code === undefined) return;

      let message = "Copied";
      try {
        await navigator.clipboard.writeText((code.textContent ?? "").replace(/^[$>]\s*/, ""));
      } catch {
        message = "Copy failed";
      }
      if (status === null) return;
      status.textContent = message;
      window.setTimeout(() => {
        status.textContent = "";
      }, 1500);
    });
  }
}