import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { GalleryStore } from "./store";
import { GalleryItem } from "./types";

/** 详情/编辑弹窗 */
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
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghub-detail");
    const it = this.item;

    // ---- 预览 ----
    const preview = contentEl.createDiv({ cls: "ghub-detail-preview" });
    if (it.type === "image" && it.path) {
      preview.createEl("img", {
        attr: { src: this.app.vault.adapter.getResourcePath(it.path) },
      });
    } else if (it.type === "video" && it.path) {
      preview.createEl("video", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          controls: "true",
        },
      });
    } else if (it.type === "link" && it.url) {
      const a = preview.createEl("a", {
        text: it.url,
        attr: { href: it.url },
      });
      a.addClass("ghub-detail-link");
    }

    // ---- 基础字段 ----
    new Setting(contentEl).setName("标题").addText((t) =>
      t.setValue(it.title).onChange((v) => this.patch({ title: v }))
    );

    new Setting(contentEl)
      .setName("标签")
      .setDesc("逗号分隔,支持 父/子 命名")
      .addText((t) =>
        t
          .setValue(it.tags.join(", "))
          .onChange((v) =>
            this.patch({
              tags: v
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          )
      );

    new Setting(contentEl).setName("评分").addDropdown((d) => {
      for (let i = 0; i <= 5; i++)
        d.addOption(String(i), i === 0 ? "未评分" : "★".repeat(i));
      d.setValue(String(it.rating)).onChange((v) =>
        this.patch({ rating: Number(v) })
      );
    });

    new Setting(contentEl).setName("来源链接").addText((t) =>
      t.setValue(it.source).onChange((v) => this.patch({ source: v }))
    );

    // ---- AI 生成元数据 ----
    contentEl.createEl("h4", { text: "AI 生成参数" });

    this.promptArea(contentEl, "Prompt", it.gen.prompt, (v) =>
      this.patchGen({ prompt: v })
    );
    this.promptArea(contentEl, "Negative Prompt", it.gen.negativePrompt, (v) =>
      this.patchGen({ negativePrompt: v })
    );

    new Setting(contentEl).setName("模型").addText((t) =>
      t.setValue(it.gen.model).onChange((v) => this.patchGen({ model: v }))
    );
    new Setting(contentEl).setName("Seed").addText((t) =>
      t.setValue(it.gen.seed).onChange((v) => this.patchGen({ seed: v }))
    );

    // ---- 备注 ----
    contentEl.createEl("h4", { text: "备注" });
    const noteArea = contentEl.createEl("textarea", {
      cls: "ghub-textarea",
    });
    noteArea.value = it.note;
    noteArea.rows = 3;
    noteArea.addEventListener("input", () =>
      this.patch({ note: noteArea.value })
    );

    // ---- 操作 ----
    const btns = contentEl.createDiv({ cls: "ghub-detail-actions" });
    if (it.gen.prompt) {
      btns
        .createEl("button", { text: "复制 Prompt" })
        .addEventListener("click", () => {
          void navigator.clipboard.writeText(it.gen.prompt);
          new Notice("Prompt 已复制");
        });
    }
    if (it.path) {
      btns
        .createEl("button", { text: "在 Obsidian 中打开" })
        .addEventListener("click", () => {
          const f = this.app.vault.getAbstractFileByPath(it.path!);
          if (f instanceof TFile) void this.app.workspace.getLeaf(true).openFile(f);
        });
    }
    const delBtn = btns.createEl("button", {
      text: "从库中移除",
      cls: "mod-warning",
    });
    delBtn.addEventListener("click", () => {
      this.store.deleteItem(it.id);
      new Notice("已从库中移除(原文件未删除)");
      this.close();
      this.onDeleted?.();
    });
  }

  private promptArea(
    parent: HTMLElement,
    label: string,
    value: string,
    onInput: (v: string) => void
  ): void {
    parent.createEl("div", { text: label, cls: "setting-item-name" });
    const ta = parent.createEl("textarea", { cls: "ghub-textarea" });
    ta.value = value;
    ta.rows = 3;
    ta.addEventListener("input", () => onInput(ta.value));
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

/** 添加链接弹窗 */
export class AddLinkModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (url: string, title: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "添加链接" });
    let url = "";
    let title = "";
    new Setting(contentEl).setName("URL").addText((t) => {
      t.setPlaceholder("https://...").onChange((v) => (url = v.trim()));
      t.inputEl.style.width = "100%";
    });
    new Setting(contentEl).setName("标题(可选)").addText((t) =>
      t.onChange((v) => (title = v.trim()))
    );
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("添加")
        .setCta()
        .onClick(() => {
          this.onSubmit(url, title);
          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
