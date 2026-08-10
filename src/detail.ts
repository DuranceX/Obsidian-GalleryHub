import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import { GalleryStore } from "./store";
import { GalleryItem } from "./types";

/** 暗房 Lightbox:左侧大图舞台 + 右侧信息栏 */
export class DetailModal extends Modal {
  constructor(
    app: App,
    private store: GalleryStore,
    private item: GalleryItem,
    private themeClass: string,
    private onDeleted?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", this.themeClass);
    const { contentEl } = this;
    contentEl.empty();
    const it = this.item;

    // ================= 左:舞台 =================
    const stage = contentEl.createDiv({ cls: "ghub-stage" });
    if (it.type === "image" && it.path) {
      const img = stage.createEl("img", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          alt: it.title || it.fileName || "图片资产",
        },
      });
      // 点击在「适应窗口 ↔ 原始大小」间切换
      img.addEventListener("click", () => {
        const zoomed = stage.hasClass("is-zoomed");
        stage.toggleClass("is-zoomed", !zoomed);
      });
      if (it.w && it.h) {
        stage.createDiv({
          cls: "ghub-stage-meta",
          text: `${it.w} × ${it.h}`,
        });
      }
    } else if (it.type === "video" && it.path) {
      stage.createEl("video", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          controls: "true",
          autoplay: "true",
          loop: "true",
        },
      });
    } else if (it.type === "audio" && it.path) {
      const box = stage.createDiv({ cls: "ghub-stage-audio" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, "music");
      box.createDiv({ cls: "ghub-stage-audio-name", text: it.fileName ?? "" });
      box.createEl("audio", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          controls: "true",
          autoplay: "true",
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

    // ---- 头部:类型徽标 + 操作图标 ----
    const head = bar.createDiv({ cls: "ghub-d-head" });
    const typeBadge = head.createSpan({ cls: "ghub-d-type" });
    const typeIcon =
      it.type === "image"
        ? "image"
        : it.type === "video"
          ? "film"
          : it.type === "audio"
            ? "music"
            : "link";
    const ticon = typeBadge.createSpan();
    setIcon(ticon, typeIcon);
    typeBadge.createSpan({
      text:
        it.type === "image"
          ? "图片"
          : it.type === "video"
            ? "视频"
            : it.type === "audio"
              ? "音频"
              : "链接",
    });
    const headActions = head.createDiv({ cls: "ghub-d-actions" });
    if (it.path) {
      this.iconBtn(headActions, "file-symlink", "在 Obsidian 中打开原文件", () => {
        const f = this.app.vault.getAbstractFileByPath(it.path!);
        if (f instanceof TFile) {
          void this.app.workspace.getLeaf(true).openFile(f);
          this.close();
        }
      });
    }
    if (it.type === "link" && it.url) {
      this.iconBtn(headActions, "external-link", "在浏览器打开", () =>
        window.open(it.url)
      );
    }
    const delBtn = this.iconBtn(
      headActions,
      "trash-2",
      "从库中移除(不删原文件)",
      () => {
        this.store.deleteItem(it.id);
        new Notice("已从库中移除(原文件未删除)");
        this.close();
        this.onDeleted?.();
      }
    );
    delBtn.addClass("ghub-danger");

    // ---- 标题(内联编辑)----
    const titleInput = bar.createEl("input", {
      cls: "ghub-title-input",
      attr: { type: "text", placeholder: "无标题", "aria-label": "标题" },
    });
    titleInput.value = it.title;
    titleInput.addEventListener("input", () =>
      this.patch({ title: titleInput.value })
    );

    // ---- 文件信息 ----
    const fmeta: string[] = [];
    if (it.fileName) fmeta.push(it.fileName);
    fmeta.push(new Date(it.createdAt).toLocaleDateString());
    bar.createDiv({ cls: "ghub-fmeta", text: fmeta.join("  ·  ") });

    // ---- 星级点选(悬停预览填充)----
    const starRow = bar.createDiv({
      cls: "ghub-starpick",
      attr: { role: "radiogroup", "aria-label": "评分" },
    });
    const renderStars = (preview?: number) => {
      starRow.empty();
      const shown = preview ?? this.item.rating;
      for (let i = 1; i <= 5; i++) {
        const s = starRow.createSpan({
          text: "★",
          cls: shown >= i ? "on" : "",
          attr: { role: "radio", "aria-label": `${i} 星` },
        });
        s.addEventListener("click", () => {
          this.patch({ rating: this.item.rating === i ? 0 : i });
          renderStars();
        });
        s.addEventListener("mouseenter", () => renderStars(i));
      }
      starRow.addEventListener("mouseleave", () => renderStars(), {
        once: true,
      });
    };
    renderStars();

    // ---- 标签 chips 编辑器 ----
    const tagField = bar.createDiv({ cls: "ghub-field" });
    tagField.createDiv({ cls: "ghub-field-label" }).createSpan({ text: "标签" });
    const chipsWrap = tagField.createDiv({ cls: "ghub-chips" });
    const renderChips = () => {
      chipsWrap.empty();
      for (const t of this.item.tags) {
        const chip = chipsWrap.createSpan({ cls: "ghub-chip" });
        chip.createSpan({ text: t });
        const x = chip.createSpan({ cls: "ghub-chip-x" });
        setIcon(x, "x");
        x.addEventListener("click", () => {
          this.patch({ tags: this.item.tags.filter((v) => v !== t) });
          renderChips();
        });
      }
      const input = chipsWrap.createEl("input", {
        cls: "ghub-chip-input",
        attr: { type: "text", placeholder: this.item.tags.length ? "" : "添加标签…" },
      });
      const commit = () => {
        const vals = input.value
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((v) => !this.item.tags.includes(v));
        if (vals.length) {
          this.patch({ tags: [...this.item.tags, ...vals] });
          renderChips();
          // 重新聚焦到新 input
          const ni = chipsWrap.querySelector<HTMLInputElement>(".ghub-chip-input");
          ni?.focus();
        } else {
          input.value = "";
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          commit();
        }
        if (
          e.key === "Backspace" &&
          !input.value &&
          this.item.tags.length
        ) {
          this.patch({ tags: this.item.tags.slice(0, -1) });
          renderChips();
          const ni = chipsWrap.querySelector<HTMLInputElement>(".ghub-chip-input");
          ni?.focus();
        }
      });
      input.addEventListener("blur", () => {
        if (input.value.trim()) commit();
      });
    };
    renderChips();

    // ---- 来源 ----
    this.field(bar, "来源链接", (wrap) => {
      const input = wrap.createEl("input", {
        attr: { type: "text", placeholder: "https://…" },
      });
      input.value = it.source;
      input.addEventListener("input", () => this.patch({ source: input.value }));
    });

    // ---- 生成参数分区卡片 ----
    const genSec = bar.createDiv({ cls: "ghub-sec" });
    const genHead = genSec.createDiv({ cls: "ghub-sec-head" });
    const gicon = genHead.createSpan({ cls: "ghub-sec-icon" });
    setIcon(gicon, "sparkles");
    genHead.createSpan({ text: "AI 生成参数" });

    this.field(genSec, "Prompt", (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "4" } });
      ta.value = it.gen.prompt;
      ta.addEventListener("input", () => this.patchGen({ prompt: ta.value }));
    }, () => this.item.gen.prompt);

    this.field(genSec, "Negative", (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "2" } });
      ta.value = it.gen.negativePrompt;
      ta.addEventListener("input", () =>
        this.patchGen({ negativePrompt: ta.value })
      );
    }, () => this.item.gen.negativePrompt);

    // 模型 / Seed 双列
    const grid2 = genSec.createDiv({ cls: "ghub-grid2" });
    this.field(grid2, "模型", (wrap) => {
      const input = wrap.createEl("input", {
        attr: { type: "text", placeholder: "flux / sd-xl…" },
      });
      input.value = it.gen.model;
      input.addEventListener("input", () => this.patchGen({ model: input.value }));
    });
    this.field(grid2, "Seed", (wrap) => {
      const input = wrap.createEl("input", { attr: { type: "text" } });
      input.value = it.gen.seed;
      input.addEventListener("input", () => this.patchGen({ seed: input.value }));
    });

    // ---- 备注 ----
    this.field(bar, "备注", (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "3" } });
      ta.value = it.note;
      ta.addEventListener("input", () => this.patch({ note: ta.value }));
    });
  }

  private iconBtn(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button", {
      cls: "ghub-icon-btn",
      attr: { "aria-label": label, title: label },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
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

/** 选择/新建 assets 子文件夹弹窗 */
export class FolderPickModal extends Modal {
  constructor(
    app: App,
    private themeClass: string,
    private folders: string[],
    private title: string,
    private onPick: (folder: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", "ghub-addlink", this.themeClass);
    const bar = this.contentEl.createDiv({ cls: "ghub-panelbar" });
    bar.createEl("h3", { text: this.title });

    if (this.folders.length) {
      const list = bar.createDiv({ cls: "ghub-folderlist" });
      for (const f of this.folders) {
        const row = list.createDiv({
          cls: "ghub-folder-row",
          attr: { role: "button", tabindex: "0" },
        });
        const ic = row.createSpan({ cls: "ghub-ficon" });
        setIcon(ic, "folder");
        row.createSpan({ text: f });
        const pick = () => {
          this.onPick(f);
          this.close();
        };
        row.addEventListener("click", pick);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter") pick();
        });
      }
    } else {
      bar.createDiv({
        cls: "ghub-side-empty",
        text: "还没有文件夹,在下面新建一个",
      });
    }

    const f = bar.createDiv({ cls: "ghub-field" });
    f.createDiv({ cls: "ghub-field-label", text: "新建文件夹" });
    const row = f.createDiv({ cls: "ghub-newfolder-row" });
    const input = row.createEl("input", {
      attr: { type: "text", placeholder: "文件夹名" },
    });
    const btn = row.createEl("button", { text: "创建并选择", cls: "mod-cta" });
    const submit = () => {
      const name = input.value.trim();
      if (!name) return;
      this.onPick(name);
      this.close();
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 批量删除确认弹窗 */
export class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private themeClass: string,
    private count: number,
    private onConfirm: (alsoTrashFiles: boolean) => void,
    private titleText?: string,
    private descText?: string,
    /** 文件夹删除等场景只有"删除"一种强度 */
    private simpleMode = false
  ) {
    super(app);
    // 传入自定义标题时默认走单按钮模式
    this.simpleMode = simpleMode || !!titleText;
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", "ghub-addlink", this.themeClass);
    const bar = this.contentEl.createDiv({ cls: "ghub-panelbar" });
    bar.createEl("h3", {
      text: this.titleText ?? `删除 ${this.count} 个资产?`,
    });
    bar.createDiv({
      cls: "ghub-side-empty",
      text:
        this.descText ??
        "「仅移出库」保留原文件;「删除文件」将文件移入系统回收站。",
    });
    const actions = bar.createDiv({ cls: "ghub-actions" });
    if (!this.simpleMode) {
      const a = actions.createEl("button", { text: "仅移出库(保留文件)" });
      a.addEventListener("click", () => {
        this.onConfirm(false);
        this.close();
      });
    }
    const b = actions.createEl("button", {
      text: this.simpleMode
        ? "确认删除(可从回收站恢复)"
        : "移出库并删除文件(可从回收站恢复)",
      cls: "ghub-danger",
    });
    b.addEventListener("click", () => {
      this.onConfirm(true);
      this.close();
    });
    const c = actions.createEl("button", { text: "取消" });
    c.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 批量编辑弹窗:标签(追加/替换/移除)与星级 */
export class BatchEditModal extends Modal {
  constructor(
    app: App,
    private themeClass: string,
    private items: GalleryItem[],
    private store: GalleryStore
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", "ghub-addlink", this.themeClass);
    const bar = this.contentEl.createDiv({ cls: "ghub-panelbar" });
    bar.createEl("h3", { text: `批量编辑 ${this.items.length} 个资产` });

    // ---- 标签 ----
    let tagMode: "add" | "replace" | "remove" = "add";
    let tagInput = "";
    const tf = bar.createDiv({ cls: "ghub-field" });
    tf.createDiv({ cls: "ghub-field-label" }).createSpan({ text: "标签" });
    const modeRow = tf.createDiv({ cls: "ghub-batch-modes" });
    const modes: Array<["add" | "replace" | "remove", string]> = [
      ["add", "追加"],
      ["replace", "替换全部"],
      ["remove", "移除"],
    ];
    const modeBtns = new Map<string, HTMLElement>();
    for (const [m, label] of modes) {
      const b = modeRow.createEl("button", {
        text: label,
        cls: m === tagMode ? "is-on" : "",
      });
      modeBtns.set(m, b);
      b.addEventListener("click", () => {
        tagMode = m;
        for (const [k, el] of modeBtns) el.toggleClass("is-on", k === m);
      });
    }
    const ti = tf.createEl("input", {
      attr: { type: "text", placeholder: "逗号分隔多个标签" },
    });
    ti.addEventListener("input", () => (tagInput = ti.value));

    // ---- 星级 ----
    let rating: number | null = null; // null = 不修改
    const rf = bar.createDiv({ cls: "ghub-field" });
    rf.createDiv({ cls: "ghub-field-label" }).createSpan({ text: "星级" });
    const starRow = rf.createDiv({ cls: "ghub-starpick" });
    const renderStars = () => {
      starRow.empty();
      for (let i = 1; i <= 5; i++) {
        const s = starRow.createSpan({
          text: "★",
          cls: rating !== null && rating >= i ? "on" : "",
        });
        s.addEventListener("click", () => {
          rating = rating === i ? null : i;
          renderStars();
        });
      }
      const hint = starRow.createSpan({
        cls: "ghub-batch-star-hint",
        text:
          rating === null
            ? "(不修改)"
            : rating === 0
              ? "(清除评分)"
              : `${rating} 星`,
      });
      hint.addEventListener("click", () => {
        rating = rating === 0 ? null : 0;
        renderStars();
      });
    };
    renderStars();
    rf.createDiv({
      cls: "ghub-side-empty",
      text: "点星星设置;再点取消;点右侧文字在「不修改/清除评分」间切换",
    });

    // ---- 应用 ----
    const actions = bar.createDiv({ cls: "ghub-actions" });
    const apply = actions.createEl("button", { text: "应用", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      const tags = tagInput
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      let changed = 0;
      for (const it of this.items) {
        const patch: Partial<GalleryItem> = {};
        if (tags.length || tagMode === "replace") {
          if (tagMode === "add") {
            const merged = [...it.tags];
            for (const t of tags) if (!merged.includes(t)) merged.push(t);
            if (merged.length !== it.tags.length) patch.tags = merged;
          } else if (tagMode === "replace") {
            if (tags.join("\n") !== it.tags.join("\n")) patch.tags = tags;
          } else {
            const left = it.tags.filter((t) => !tags.includes(t));
            if (left.length !== it.tags.length) patch.tags = left;
          }
        }
        if (rating !== null && it.rating !== rating) patch.rating = rating;
        if (Object.keys(patch).length) {
          this.store.updateItem(it.id, patch);
          changed++;
        }
      }
      new Notice(changed ? `已更新 ${changed} 个资产` : "没有需要修改的内容");
      this.close();
    });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 添加链接弹窗(暗房皮肤) */
export class AddLinkModal extends Modal {
  constructor(
    app: App,
    private themeClass: string,
    private onSubmit: (url: string, title: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", "ghub-addlink", this.themeClass);
    const { contentEl } = this;
    const bar = contentEl.createDiv({ cls: "ghub-panelbar" });

    // 头部:图标 + 标题(与详情页头部风格一致)
    const head = bar.createDiv({ cls: "ghub-d-head ghub-addlink-head" });
    const badge = head.createSpan({ cls: "ghub-d-type" });
    const ic = badge.createSpan();
    setIcon(ic, "link");
    badge.createSpan({ text: "添加链接" });

    let url = "";
    let title = "";
    const f1 = bar.createDiv({ cls: "ghub-field" });
    f1.createDiv({ cls: "ghub-field-label" }).createSpan({ text: "URL" });
    const urlInput = f1.createEl("input", {
      attr: { type: "text", placeholder: "https://…" },
    });
    urlInput.addEventListener("input", () => (url = urlInput.value.trim()));
    const f2 = bar.createDiv({ cls: "ghub-field" });
    f2.createDiv({ cls: "ghub-field-label" }).createSpan({ text: "标题(可选)" });
    const titleInput = f2.createEl("input", {
      attr: { type: "text", placeholder: "留空自动取域名" },
    });
    titleInput.addEventListener("input", () => (title = titleInput.value.trim()));

    const submit = () => {
      this.onSubmit(url, title);
      this.close();
    };
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    const actions = bar.createDiv({ cls: "ghub-actions" });
    const ok = actions.createEl("button", { text: "添加", cls: "mod-cta" });
    ok.addEventListener("click", submit);
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());

    window.setTimeout(() => urlInput.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
