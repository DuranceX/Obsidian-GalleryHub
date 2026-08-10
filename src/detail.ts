import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import { GalleryStore } from "./store";
import { GalleryItem } from "./types";

/** 暗房 Lightbox:左侧大图舞台 + 右侧信息栏 */
export class DetailModal extends Modal {
  constructor(
    app: App,
    private store: GalleryStore,
    private item: GalleryItem,
    private onDeleted?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal");
    const { contentEl } = this;
    contentEl.empty();
    const it = this.item;

    // ================= 左:舞台 =================
    const stage = contentEl.createDiv({ cls: "ghub-stage" });
    if (it.type === "image" && it.path) {
      stage.createEl("img", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          alt: it.title || it.fileName || "图片资产",
        },
      });
    } else if (it.type === "video" && it.path) {
      stage.createEl("video", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          controls: "true",
          autoplay: "true",
          loop: "true",
        },
      });
    } else if (it.type === "link" && it.url) {
      const box = stage.createDiv({ cls: "ghub-stage-link" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, "link");
      box.createEl("a", { text: it.url, attr: { href: it.url } });
    }

    // ================= 右:信息栏 =================
    const bar = contentEl.createDiv({ cls: "ghub-panelbar" });

    // 标题(内联编辑)
    const titleInput = bar.createEl("input", {
      cls: "ghub-title-input",
      attr: { type: "text", placeholder: "无标题", "aria-label": "标题" },
    });
    titleInput.value = it.title;
    titleInput.addEventListener("input", () =>
      this.patch({ title: titleInput.value })
    );

    // 文件信息
    const fmeta: string[] = [];
    if (it.fileName) fmeta.push(it.fileName);
    if (it.w && it.h) fmeta.push(`${it.w}×${it.h}`);
    fmeta.push(new Date(it.createdAt).toLocaleDateString());
    bar.createDiv({ cls: "ghub-fmeta", text: fmeta.join(" · ") });

    // 星级点选
    const starRow = bar.createDiv({
      cls: "ghub-starpick",
      attr: { role: "radiogroup", "aria-label": "评分" },
    });
    const renderStars = () => {
      starRow.empty();
      for (let i = 1; i <= 5; i++) {
        const s = starRow.createSpan({
          text: "★",
          cls: this.item.rating >= i ? "on" : "",
          attr: { role: "radio", "aria-label": `${i} 星` },
        });
        s.addEventListener("click", () => {
          this.patch({ rating: this.item.rating === i ? 0 : i });
          renderStars();
        });
      }
    };
    renderStars();

    // 标签
    this.field(bar, "标签", (wrap) => {
      const input = wrap.createEl("input", {
        attr: { type: "text", placeholder: "逗号分隔,支持 父/子" },
      });
      input.value = it.tags.join(", ");
      input.addEventListener("input", () =>
        this.patch({
          tags: input.value
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        })
      );
    });

    // 来源
    this.field(bar, "来源链接", (wrap) => {
      const input = wrap.createEl("input", {
        attr: { type: "text", placeholder: "https://…" },
      });
      input.value = it.source;
      input.addEventListener("input", () => this.patch({ source: input.value }));
    });

    bar.createEl("hr", { cls: "ghub-hr" });

    // ---- AI 生成参数 ----
    this.field(bar, "Prompt", (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "4" } });
      ta.value = it.gen.prompt;
      ta.addEventListener("input", () => this.patchGen({ prompt: ta.value }));
    }, () => this.item.gen.prompt);

    this.field(bar, "Negative", (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "2" } });
      ta.value = it.gen.negativePrompt;
      ta.addEventListener("input", () =>
        this.patchGen({ negativePrompt: ta.value })
      );
    }, () => this.item.gen.negativePrompt);

    this.field(bar, "模型", (wrap) => {
      const input = wrap.createEl("input", {
        attr: { type: "text", placeholder: "flux / sd-xl / mj…" },
      });
      input.value = it.gen.model;
      input.addEventListener("input", () => this.patchGen({ model: input.value }));
    });

    this.field(bar, "Seed", (wrap) => {
      const input = wrap.createEl("input", { attr: { type: "text" } });
      input.value = it.gen.seed;
      input.addEventListener("input", () => this.patchGen({ seed: input.value }));
    });

    bar.createEl("hr", { cls: "ghub-hr" });

    // 备注
    this.field(bar, "备注", (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "3" } });
      ta.value = it.note;
      ta.addEventListener("input", () => this.patch({ note: ta.value }));
    });

    // ---- 操作 ----
    const actions = bar.createDiv({ cls: "ghub-actions" });
    if (it.path) {
      this.action(actions, "file-symlink", "在 Obsidian 中打开原文件", () => {
        const f = this.app.vault.getAbstractFileByPath(it.path!);
        if (f instanceof TFile) {
          void this.app.workspace.getLeaf(true).openFile(f);
          this.close();
        }
      });
    }
    if (it.type === "link" && it.url) {
      this.action(actions, "external-link", "在浏览器打开", () =>
        window.open(it.url)
      );
    }
    const del = this.action(actions, "trash-2", "从库中移除(不删原文件)", () => {
      this.store.deleteItem(it.id);
      new Notice("已从库中移除(原文件未删除)");
      this.close();
      this.onDeleted?.();
    });
    del.addClass("ghub-danger");
  }

  /** 带小标题的字段;getCopyText 提供时在标题右侧生成复制按钮 */
  private field(
    parent: HTMLElement,
    label: string,
    build: (wrap: HTMLElement) => void,
    getCopyText?: () => string
  ): void {
    const f = parent.createDiv({ cls: "ghub-field" });
    const head = f.createDiv({ cls: "ghub-field-label" });
    head.createSpan({ text: label });
    if (getCopyText) {
      const btn = head.createEl("button", {
        cls: "ghub-copy-btn",
        attr: { "aria-label": `复制 ${label}` },
      });
      const ic = btn.createSpan();
      setIcon(ic, "copy");
      btn.createSpan({ text: "复制" });
      btn.addEventListener("click", () => {
        const text = getCopyText();
        if (!text) {
          new Notice(`${label} 为空`);
          return;
        }
        void navigator.clipboard.writeText(text);
        new Notice(`${label} 已复制`);
      });
    }
    build(f);
  }

  private action(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button");
    const ic = btn.createSpan();
    setIcon(ic, icon);
    btn.createSpan({ text: label });
    btn.addEventListener("click", onClick);
    return btn;
  }

  private patch(p: Partial<GalleryItem>): void {
    this.store.updateItem(this.item.id, p);
  }

  private patchGen(p: Partial<GalleryItem["gen"]>): void {
    const gen = { ...this.item.gen, ...p };
    this.store.updateItem(this.item.id, { gen });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 添加链接弹窗(暗房皮肤) */
export class AddLinkModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (url: string, title: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", "ghub-addlink");
    const { contentEl } = this;
    const bar = contentEl.createDiv({ cls: "ghub-panelbar" });
    bar.style.width = "100%";
    bar.style.borderLeft = "none";
    bar.createEl("h3", { text: "添加链接" });
    let url = "";
    let title = "";
    const f1 = bar.createDiv({ cls: "ghub-field" });
    f1.createDiv({ cls: "ghub-field-label", text: "URL" });
    const urlInput = f1.createEl("input", {
      attr: { type: "text", placeholder: "https://…" },
    });
    urlInput.addEventListener("input", () => (url = urlInput.value.trim()));
    const f2 = bar.createDiv({ cls: "ghub-field" });
    f2.createDiv({ cls: "ghub-field-label", text: "标题(可选)" });
    const titleInput = f2.createEl("input", { attr: { type: "text" } });
    titleInput.addEventListener("input", () => (title = titleInput.value.trim()));
    const actions = bar.createDiv({ cls: "ghub-actions" });
    const ok = actions.createEl("button", { text: "添加", cls: "mod-cta" });
    ok.addEventListener("click", () => {
      this.onSubmit(url, title);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
