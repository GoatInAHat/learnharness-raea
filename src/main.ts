import type {
  PluginFrontendContext,
  PluginSettingsSchema,
  PluginWidgetHandle,
} from "../sdk/index.ts";

type Settings = {
  enabled: boolean;
  maxSeconds: 10 | 15 | 25 | 45 | 60 | 90;
  narration: boolean;
  voice: "alba" | "marius";
  theme: "dark" | "light";
};
type Status = {
  status: string;
  error?: string;
  plan: { title: string; scenes: { heading: string; caption: string }[] };
  enabled: boolean;
  installed: boolean;
  speechInstalled: boolean;
  speechDownloadMiB: number;
  narration: boolean;
  activity?: string;
  platform: { downloadMiB: number; disk: string } | null;
};
export async function activate(ctx: PluginFrontendContext) {
  let preferences = await ctx.call<Settings>("settings");
  let saving = false;
  let widget: PluginWidgetHandle<PluginSettingsSchema>;
  const rows = (): PluginSettingsSchema => ({
    rows: [
      {
        key: "enabled",
        type: "toggle",
        label: "Allow new explainer videos",
        description:
          "Turn off new video creation while keeping saved videos playable. Try asking your teacher: “Explain binary search with a short video.”",
        value: preferences.enabled,
        disabled: saving,
        onChange: (value) => save("enabled", value),
      },
      {
        key: "duration",
        type: "dropdown",
        label: "Maximum length",
        description: "Applies to newly created plans.",
        value: String(preferences.maxSeconds),
        disabled: saving,
        options: [10, 15, 25, 45, 60, 90].map((n) => ({
          value: String(n),
          label: `${n} seconds`,
        })),
        onChange: (value) => save("maxSeconds", Number(value)),
      },
      {
        key: "narration",
        type: "toggle",
        label: "Narration",
        description:
          "Use an offline English-language voice for new animations. The first use downloads a voice model.",
        value: preferences.narration,
        disabled: saving,
        onChange: (value) => save("narration", value),
      },
      {
        key: "voice",
        type: "dropdown",
        label: "Narrator voice",
        description: "Applies to new renders.",
        value: preferences.voice,
        disabled: saving || !preferences.narration,
        options: [
          { value: "alba", label: "Alba" },
          { value: "marius", label: "Marius" },
        ],
        onChange: (value) => save("voice", value),
      },
      {
        key: "theme",
        type: "dropdown",
        label: "Video theme",
        description: "Applies to future renders.",
        value: preferences.theme,
        disabled: saving,
        options: [
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ],
        onChange: (value) => save("theme", value),
      },
    ],
  });
  async function save(key: keyof Settings, value: unknown) {
    if (saving) return;
    saving = true;
    widget.update(rows());
    try {
      preferences = await ctx.call<Settings>("save-settings", { key, value });
    } finally {
      saving = false;
      widget.update(rows());
    }
  }
  widget = ctx.registerSettings(rows());
  const offSettings = ctx.onNotification((event) => {
    if (event.topic === "settings-changed" && !saving)
      void ctx
        .call<Settings>("settings")
        .then((value) => {
          if (!ctx.signal.aborted) {
            preferences = value;
            widget.update(rows());
          }
        })
        .catch(() => {});
  });
  ctx.registerToolRenderer({
    toolName: "raea_explainer_video",
    mount(container, tool) {
      let url: string | undefined,
        disposed = false,
        sequence = 0,
        loadedId: string | undefined,
        loading: Promise<void> | undefined;
      let video: HTMLVideoElement | undefined;
      const id = (
        (tool.output ?? tool.result?.details) as { id?: unknown } | undefined
      )?.id;
      const title = document.createElement("strong");
      title.textContent = "Explainer video";
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      const controls = document.createElement("div");
      const content = document.createElement("div");
      container.append(title, status, controls, content);
      let buttons: Array<{ dispose(): void }> = [];
      const clearButtons = () => {
        for (const handle of buttons) handle.dispose();
        buttons = [];
        controls.replaceChildren();
      };
      const button = (label: string, action: () => Promise<void> | void) => {
        const slot = document.createElement("span");
        controls.append(slot);
        const handle = ctx.ui.mountButton(
          slot,
          {
            label,
            size: "sm",
            variant: "outline",
            onClick: async () => {
              handle.update({ disabled: true });
              try {
                await action();
              } catch (error) {
                if (!disposed)
                  status.textContent =
                    error instanceof Error ? error.message : String(error);
              } finally {
                if (!disposed) handle.update({ disabled: false });
              }
            },
          },
          { signal: tool.signal },
        );
        buttons.push(handle);
      };
      const settingsButton = () =>
        button("Video settings", () => ctx.app.openSettings());
      async function loadVideo() {
        if (loading) return loading;
        loading = loadVideoOnce();
        try {
          await loading;
        } finally {
          loading = undefined;
        }
      }
      async function loadVideoOnce() {
        if (typeof id !== "string" || loadedId === id) return;
        const parts: Uint8Array[] = [];
        let offset = 0,
          total = 0;
        do {
          const chunk = await ctx.call<{ data: string; size: number }>(
            "chunk",
            { id, offset },
          );
          if (disposed || tool.signal.aborted) return;
          if (
            !Number.isSafeInteger(chunk.size) ||
            chunk.size < 1 ||
            chunk.size > 25_000_000 ||
            (total && total !== chunk.size)
          )
            throw new Error("Video changed while loading");
          total = chunk.size;
          const raw = atob(chunk.data);
          const data = Uint8Array.from(raw, (c) => c.charCodeAt(0));
          if (
            !data.length ||
            offset + data.length > total ||
            (offset + data.length < total && data.length !== 512 * 1024)
          )
            throw new Error("Invalid video chunk");
          parts.push(data);
          offset += data.length;
        } while (offset < total);
        if (disposed || tool.signal.aborted) return;
        url = URL.createObjectURL(
          new Blob(parts as BlobPart[], { type: "video/mp4" }),
        );
        loadedId = id;
        video = document.createElement("video");
        video.controls = true;
        video.preload = "metadata";
        video.style.maxWidth = "100%";
        video.src = url;
        video.onerror = () => {
          status.textContent = "Unable to play this video. Load it again.";
          video?.remove();
          video = undefined;
          if (url) URL.revokeObjectURL(url);
          url = undefined;
          loadedId = undefined;
          safeRefresh();
        };
        content.prepend(video);
        safeRefresh();
      }
      async function refresh() {
        if (typeof id !== "string") {
          status.textContent =
            tool.state === "output-error"
              ? tool.errorText || "Video plan failed."
              : "Preparing video plan…";
          return;
        }
        const current = ++sequence;
        const item = await ctx.call<Status>("status", { id });
        if (disposed || tool.signal.aborted || current !== sequence) return;
        clearButtons();
        settingsButton();
        status.textContent =
          item.status === "running"
            ? item.activity || "Rendering video…"
            : item.status === "done"
              ? "Video ready"
              : item.error || "Video ready to render";
        if (item.status === "done") {
          if (!loadedId) button("Load video", loadVideo);
        } else if (item.status === "running")
          button("Cancel", async () => {
            await ctx.call("cancel", { id });
          });
        else if (!item.enabled)
          status.textContent =
            "New explainer videos are disabled in plugin settings.";
        else if (!item.platform)
          status.textContent =
            "Video rendering is unavailable on this platform.";
        else
          button(
            !item.installed && item.narration && !item.speechInstalled
              ? `Download Raea (${item.platform.downloadMiB} MiB; ${item.platform.disk}) and local voice model (${item.speechDownloadMiB} MiB), then render`
              : !item.installed
                ? `Download Raea (${item.platform.downloadMiB} MiB; ${item.platform.disk}) and render`
                : item.narration && !item.speechInstalled
                  ? `Download local voice model (${item.speechDownloadMiB} MiB) and render`
                  : "Render video",
            async () => {
              await ctx.call("start", {
                id,
                downloadRuntime: !item.installed,
                downloadSpeech: item.narration && !item.speechInstalled,
              });
              await refresh();
            },
          );
        if (!content.querySelector("details")) {
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = "Video transcript";
          details.append(summary);
          for (const scene of item.plan.scenes) {
            const p = document.createElement("p");
            p.textContent = `${scene.heading}: ${"narration" in scene ? scene.narration : scene.caption}`;
            details.append(p);
          }
          content.append(details);
        }
      }
      const safeRefresh = () => {
        void refresh().catch((error) => {
          if (!disposed)
            status.textContent =
              error instanceof Error ? error.message : String(error);
        });
      };
      const off = ctx.onNotification((event) => {
        if (
          (event.topic === "video-changed" &&
            (event.data as { id?: unknown } | undefined)?.id === id) ||
          event.topic === "settings-changed"
        )
          safeRefresh();
      });
      const offResync = ctx.onResync(safeRefresh);
      safeRefresh();
      return () => {
        disposed = true;
        off();
        offResync();
        clearButtons();
        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
        if (url) URL.revokeObjectURL(url);
        container.replaceChildren();
      };
    },
  });
  return () => {
    offSettings();
    widget.dispose();
  };
}
