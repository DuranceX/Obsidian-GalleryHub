import { App, Modal, Notice, TFile, FuzzySuggestModal, setIcon } from "obsidian";
import { t } from "./i18n";
import { GalleryStore } from "./store";
import { GalleryItem } from "./types";
import { openResource, targetIcon, classifyTarget } from "./resource";

/** AI 参数分区折叠状态:模块级,跨卡片、跨弹窗同步(会话内记忆) */
let genSectionCollapsed = false;

/** 暗房 Lightbox:左侧大图舞台 + 右侧信息栏;可在序列中左右切换 */
export class DetailModal extends Modal {
  constructor(
    app: App,
    private store: GalleryStore,
    private item: GalleryItem,
    private themeClass: string,
    private onDeleted?: () => void,
    /** 可切换的条目序列(当前筛选结果);未提供则无切换按钮 */
    private sequence?: GalleryItem[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", this.themeClass);
    this.renderCurrent();

    // ←/→ 键切换;正在输入(input/textarea/可编辑区)时交还给光标移动,不切换
    const editing = (): boolean => {
      const el = document.activeElement;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      );
    };
    this.scope.register([], "ArrowLeft", () => {
      if (editing()) return true;
      this.step(-1);
      return false;
    });
    this.scope.register([], "ArrowRight", () => {
      if (editing()) return true;
      this.step(1);
      return false;
    });
  }

  private seqIndex(): number {
    if (!this.sequence) return -1;
    return this.sequence.findIndex((x) => x.id === this.item.id);
  }

  private step(dir: -1 | 1): void {
    if (!this.sequence?.length) return;
    const idx = this.seqIndex();
    if (idx < 0) return;
    const next = this.sequence[idx + dir];
    if (!next) return;
    this.item = next;
    this.renderCurrent();
  }

  private renderCurrent(): void {
    const { contentEl } = this;
    contentEl.empty();
    const it = this.item;

    // 序列切换按钮(窗口左右边缘悬浮)
    if (this.sequence && this.sequence.length > 1) {
      const idx = this.seqIndex();
      if (idx > 0) {
        const prev = contentEl.createEl("button", {
          cls: "ghub-nav-btn ghub-nav-prev",
          attr: { "aria-label": t("prevItem") },
        });
        setIcon(prev, "chevron-left");
        prev.addEventListener("click", (e) => {
          e.stopPropagation();
          this.step(-1);
        });
      }
      if (idx >= 0 && idx < this.sequence.length - 1) {
        const next = contentEl.createEl("button", {
          cls: "ghub-nav-btn ghub-nav-next",
          attr: { "aria-label": t("nextItem") },
        });
        setIcon(next, "chevron-right");
        next.addEventListener("click", (e) => {
          e.stopPropagation();
          this.step(1);
        });
      }
    }

    // ================= 左:舞台 =================
    const stage = contentEl.createDiv({ cls: "ghub-stage" });
    if (it.type === "image" && it.path) {
      const img = stage.createEl("img", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          alt: it.title || it.fileName || t("image"),
          draggable: "false",
        },
      });
      // 点击放大(原始尺寸,聚焦到点击处);放大后拖动平移;未拖动的单击还原
      let dragging = false;
      let moved = false;
      let sx = 0;
      let sy = 0;
      let sl = 0;
      let st = 0;
      img.addEventListener("pointerdown", (e) => {
        if (!stage.hasClass("is-zoomed") || e.button !== 0) return;
        dragging = true;
        moved = false;
        sx = e.clientX;
        sy = e.clientY;
        sl = stage.scrollLeft;
        st = stage.scrollTop;
        stage.addClass("is-grabbing");
        img.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      img.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        stage.scrollLeft = sl - dx;
        stage.scrollTop = st - dy;
      });
      const endDrag = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        stage.removeClass("is-grabbing");
        try {
          img.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };
      img.addEventListener("pointerup", endDrag);
      img.addEventListener("pointercancel", endDrag);
      img.addEventListener("click", (e) => {
        if (stage.hasClass("is-zoomed")) {
          // 拖动过的松手不算"点击还原"
          if (moved) {
            moved = false;
            return;
          }
          stage.removeClass("is-zoomed");
        } else {
          // 记录点击在图片上的相对位置,放大后滚动聚焦到该处
          const rect = img.getBoundingClientRect();
          const fx = (e.clientX - rect.left) / rect.width;
          const fy = (e.clientY - rect.top) / rect.height;
          stage.addClass("is-zoomed");
          window.requestAnimationFrame(() => {
            stage.scrollLeft = img.offsetWidth * fx - stage.clientWidth / 2;
            stage.scrollTop = img.offsetHeight * fy - stage.clientHeight / 2;
          });
        }
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
      setIcon(ic, targetIcon(it.url));
      const a = box.createEl("a", { text: it.url, attr: { href: "#" } });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void openResource(this.app, it.url!);
      });
    } else if (it.type === "note") {
      // 笔记:舞台即编辑区,大文本框直改 note 字段
      const box = stage.createDiv({ cls: "ghub-stage-note" });
      const ta = box.createEl("textarea", {
        attr: { placeholder: t("notePlaceholder"), spellcheck: "false" },
      });
      ta.value = it.note;
      ta.addEventListener("input", () => this.patch({ note: ta.value }));
      window.setTimeout(() => ta.focus(), 30);
    }

    // ================= 右:信息栏 =================
    const bar = contentEl.createDiv({ cls: "ghub-panelbar" });
    // 信息栏滚动后给关闭按钮加底衬(否则它悬在内容上像一个裸文字);
    // 回到顶部则恢复无背景。CSS 负责过渡动画。
    const syncScrolled = () => {
      this.modalEl.toggleClass("is-scrolled", bar.scrollTop > 4);
    };
    bar.addEventListener("scroll", syncScrolled);
    syncScrolled();

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
            : it.type === "note"
              ? "type"
              : targetIcon(it.url ?? "");
    const ticon = typeBadge.createSpan();
    setIcon(ticon, typeIcon);
    typeBadge.createSpan({
      text:
        it.type === "image"
          ? t("image")
          : it.type === "video"
            ? t("video")
            : it.type === "audio"
              ? t("audio")
              : it.type === "note"
                ? t("note")
                : t("link"),
    });
    const headActions = head.createDiv({ cls: "ghub-d-actions" });
    if (it.path) {
      this.iconBtn(headActions, "file-symlink", t("openInObsidian"), () => {
        const f = this.app.vault.getAbstractFileByPath(it.path!);
        if (f instanceof TFile) {
          void this.app.workspace.getLeaf(true).openFile(f);
          this.close();
        }
      });
    }
    if (it.type === "link" && it.url) {
      const kind = classifyTarget(it.url);
      const label = kind === "url" ? t("openInBrowser") : t("openTarget");
      const icon = kind === "url" ? "external-link" : targetIcon(it.url);
      this.iconBtn(headActions, icon, label, () =>
        void openResource(this.app, it.url!)
      );
    }
    const delBtn = this.iconBtn(
      headActions,
      "trash-2",
      t("removeFromLibrary"),
      () => {
        this.store.deleteItem(it.id);
        new Notice(t("removedKeepFile"));
        this.close();
        this.onDeleted?.();
      }
    );
    delBtn.addClass("ghub-danger");

    // ---- 标题(内联编辑)----
    const titleInput = bar.createEl("input", {
      cls: "ghub-title-input",
      attr: { type: "text", placeholder: t("detailTitlePlaceholder"), "aria-label": t("detailTitleAria") },
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
    // 星星只创建一次,悬停/点击仅切换 class。若在 mouseenter 里重建 DOM,
    // mousedown 的目标元素会在 mouseup 前被销毁,浏览器不派发 click(点星无反应)。
    const starRow = bar.createDiv({
      cls: "ghub-starpick",
      attr: { role: "radiogroup", "aria-label": t("ratingAria") },
    });
    const stars: HTMLElement[] = [];
    const paintStars = (shown: number) => {
      stars.forEach((s, idx) => s.toggleClass("on", idx < shown));
    };
    for (let i = 1; i <= 5; i++) {
      const s = starRow.createSpan({
        text: "★",
        attr: { role: "radio", "aria-label": t("nStars", { n: i }) },
      });
      stars.push(s);
      s.addEventListener("click", () => {
        const next = this.item.rating === i ? 0 : i;
        this.patch({ rating: next });
        paintStars(next);
      });
      s.addEventListener("mouseenter", () => paintStars(i));
    }
    starRow.addEventListener("mouseleave", () => paintStars(this.item.rating));
    paintStars(it.rating);

    // ---- 标签 chips 编辑器 ----
    const tagField = bar.createDiv({ cls: "ghub-field" });
    tagField.createDiv({ cls: "ghub-field-label" }).createSpan({ text: t("tags") });
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
        attr: { type: "text", placeholder: this.item.tags.length ? "" : t("tagsPlaceholder") },
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
    this.field(bar, t("sourceLink"), (wrap) => {
      const input = wrap.createEl("input", {
        attr: { type: "text", placeholder: "https://…" },
      });
      input.value = it.source;
      input.addEventListener("input", () => this.patch({ source: input.value }));
    });

    // ---- 源文件位置(自定义,可作"图片链接") ----
    this.field(bar, t("originPathField"), (wrap) => {
      const input = wrap.createEl("input", {
        attr: {
          type: "text",
          placeholder: t("originPathPlaceholder"),
        },
      });
      input.value = it.originPath ?? "";
      input.addEventListener("input", () =>
        this.patch({ originPath: input.value.trim() || undefined })
      );
    });

    // ---- 生成参数分区卡片(可折叠,状态模块级同步) ----
    const genSec = bar.createDiv({ cls: "ghub-sec" });
    const genHead = genSec.createDiv({
      cls: "ghub-sec-head",
      attr: { role: "button", tabindex: "0", "aria-expanded": String(!genSectionCollapsed) },
    });
    const gicon = genHead.createSpan({ cls: "ghub-sec-icon" });
    setIcon(gicon, "sparkles");
    genHead.createSpan({ text: t("genSection") });
    const chevron = genHead.createSpan({ cls: "ghub-sec-chevron" });
    const genBody = genSec.createDiv({ cls: "ghub-sec-body" });
    const applyCollapsed = () => {
      setIcon(chevron, genSectionCollapsed ? "chevron-right" : "chevron-down");
      genBody.toggleClass("is-collapsed", genSectionCollapsed);
      genHead.setAttribute("aria-expanded", String(!genSectionCollapsed));
    };
    const toggleCollapsed = () => {
      genSectionCollapsed = !genSectionCollapsed;
      applyCollapsed();
    };
    genHead.addEventListener("click", toggleCollapsed);
    genHead.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCollapsed();
      }
    });

    this.field(genBody, t("promptLabel"), (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "4" } });
      ta.value = it.gen.prompt;
      ta.addEventListener("input", () => this.patchGen({ prompt: ta.value }));
    }, () => this.item.gen.prompt);

    this.field(genBody, t("negativeLabel"), (wrap) => {
      const ta = wrap.createEl("textarea", { attr: { rows: "2" } });
      ta.value = it.gen.negativePrompt;
      ta.addEventListener("input", () =>
        this.patchGen({ negativePrompt: ta.value })
      );
    }, () => this.item.gen.negativePrompt);

    // 模型 / Seed 双列
    const grid2 = genBody.createDiv({ cls: "ghub-grid2" });
    this.field(grid2, t("modelLabel"), (wrap) => {
      const input = wrap.createEl("input", {
        attr: { type: "text", placeholder: t("modelPlaceholder") },
      });
      input.value = it.gen.model;
      input.addEventListener("input", () => this.patchGen({ model: input.value }));
    });
    this.field(grid2, t("seedLabel"), (wrap) => {
      const input = wrap.createEl("input", { attr: { type: "text" } });
      input.value = it.gen.seed;
      input.addEventListener("input", () => this.patchGen({ seed: input.value }));
    });
    applyCollapsed();

    // ---- 备注(笔记类型的正文在左侧舞台编辑,此处不重复) ----
    if (it.type !== "note") {
      this.field(bar, t("noteLabel"), (wrap) => {
        const ta = wrap.createEl("textarea", { attr: { rows: "3" } });
        ta.value = it.note;
        ta.addEventListener("input", () => this.patch({ note: ta.value }));
      });
    }
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
        attr: { "aria-label": t("copyAria", { label }) },
      });
      const ic = btn.createSpan();
      setIcon(ic, "copy");
      btn.createSpan({ text: t("copyBtn") });
      btn.addEventListener("click", () => {
        const text = getCopyText();
        if (!text) {
          new Notice(t("emptyField", { label }));
          return;
        }
        void navigator.clipboard.writeText(text);
        new Notice(t("copied", { label }));
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

    const list = bar.createDiv({ cls: "ghub-folderlist" });
    const addRow = (folder: string, label: string, icon: string) => {
      const row = list.createDiv({
        cls: "ghub-folder-row",
        attr: { role: "button", tabindex: "0" },
      });
      const ic = row.createSpan({ cls: "ghub-ficon" });
      setIcon(ic, icon);
      row.createSpan({ text: label });
      const pick = () => {
        this.onPick(folder);
        this.close();
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") pick();
      });
    };
    // 根目录选项:"/" 表示移到 assets 根
    addRow("", "/", "corner-left-up");
    for (const f of this.folders) addRow(f, f, "folder");

    const f = bar.createDiv({ cls: "ghub-field" });
    f.createDiv({ cls: "ghub-field-label", text: t("newFolderLabel") });
    const row = f.createDiv({ cls: "ghub-newfolder-row" });
    const input = row.createEl("input", {
      attr: { type: "text", placeholder: t("folderNamePlaceholder") },
    });
    const btn = row.createEl("button", { text: t("createAndSelect"), cls: "mod-cta" });
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
      text: this.titleText ?? t("deleteNAssets", { n: this.count }),
    });
    bar.createDiv({
      cls: "ghub-side-empty",
      text:
        this.descText ??
        t("deleteChoiceDesc"),
    });
    const actions = bar.createDiv({ cls: "ghub-actions" });
    if (!this.simpleMode) {
      const a = actions.createEl("button", { text: t("removeOnlyBtn") });
      a.addEventListener("click", () => {
        this.onConfirm(false);
        this.close();
      });
    }
    const b = actions.createEl("button", {
      text: this.simpleMode
        ? t("confirmDeleteBtn")
        : t("removeAndTrashBtn"),
      cls: "ghub-danger",
    });
    b.addEventListener("click", () => {
      this.onConfirm(true);
      this.close();
    });
    const c = actions.createEl("button", { text: t("cancel") });
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
    bar.createEl("h3", { text: t("batchEditTitle", { n: this.items.length }) });

    // ---- 标签 ----
    let tagMode: "add" | "replace" | "remove" = "add";
    let tagInput = "";
    const tf = bar.createDiv({ cls: "ghub-field" });
    tf.createDiv({ cls: "ghub-field-label" }).createSpan({ text: t("tags") });
    const modeRow = tf.createDiv({ cls: "ghub-batch-modes" });
    const modes: Array<["add" | "replace" | "remove", string]> = [
      ["add", t("tagModeAdd")],
      ["replace", t("tagModeReplace")],
      ["remove", t("tagModeRemove")],
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
      attr: { type: "text", placeholder: t("batchTagsPlaceholder") },
    });
    ti.addEventListener("input", () => (tagInput = ti.value));

    // ---- 星级 ----
    let rating: number | null = null; // null = 不修改
    const rf = bar.createDiv({ cls: "ghub-field" });
    rf.createDiv({ cls: "ghub-field-label" }).createSpan({ text: t("starLabel") });
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
            ? t("starNoChange")
            : rating === 0
              ? t("starClear")
              : t("nStars", { n: rating }),
      });
      hint.addEventListener("click", () => {
        rating = rating === 0 ? null : 0;
        renderStars();
      });
    };
    renderStars();
    rf.createDiv({
      cls: "ghub-side-empty",
      text: t("starHint"),
    });

    // ---- 应用 ----
    const actions = bar.createDiv({ cls: "ghub-actions" });
    const apply = actions.createEl("button", { text: t("apply"), cls: "mod-cta" });
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
      new Notice(changed ? t("updatedN", { n: changed }) : t("nothingToUpdate"));
      this.close();
    });
    const cancel = actions.createEl("button", { text: t("cancel") });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 物理删除二次确认(带"不再提醒"勾选) */
export class ConfirmTrashModal extends Modal {
  constructor(
    app: App,
    private themeClass: string,
    private count: number,
    private onConfirm: (skipNextTime: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ghub-detail-modal", "ghub-addlink", this.themeClass);
    const bar = this.contentEl.createDiv({ cls: "ghub-panelbar" });

    const head = bar.createDiv({ cls: "ghub-d-head ghub-addlink-head" });
    const badge = head.createSpan({ cls: "ghub-d-type" });
    const ic = badge.createSpan();
    setIcon(ic, "trash-2");
    badge.createSpan({ text: t("trashNTitle", { n: this.count }) });

    bar.createDiv({
      cls: "ghub-side-empty",
      text: t("trashDesc"),
    });

    let skip = false;
    const skipRow = bar.createDiv({ cls: "ghub-skip-row" });
    const cb = skipRow.createEl("input", {
      attr: { type: "checkbox", id: "ghub-skip-confirm" },
    });
    skipRow.createEl("label", {
      text: t("dontAskAgain"),
      attr: { for: "ghub-skip-confirm" },
    });
    cb.addEventListener("change", () => (skip = cb.checked));

    const actions = bar.createDiv({ cls: "ghub-actions" });
    const ok = actions.createEl("button", {
      text: t("trashBtn"),
      cls: "ghub-danger",
    });
    ok.addEventListener("click", () => {
      this.onConfirm(skip);
      this.close();
    });
    const cancel = actions.createEl("button", { text: t("cancel") });
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
    badge.createSpan({ text: t("addLinkTitle") });

    let url = "";
    let title = "";
    const f1 = bar.createDiv({ cls: "ghub-field" });
    f1.createDiv({ cls: "ghub-field-label" }).createSpan({ text: t("urlLabel") });
    const urlInput = f1.createEl("input", {
      attr: { type: "text", placeholder: "https://…  /  /path/to/file.psd" },
    });
    urlInput.addEventListener("input", () => (url = urlInput.value.trim()));
    const f2 = bar.createDiv({ cls: "ghub-field" });
    f2.createDiv({ cls: "ghub-field-label" }).createSpan({ text: t("titleOptional") });
    const titleInput = f2.createEl("input", {
      attr: { type: "text", placeholder: t("titleAutoDomain") },
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
    const ok = actions.createEl("button", { text: t("add"), cls: "mod-cta" });
    ok.addEventListener("click", submit);
    const cancel = actions.createEl("button", { text: t("cancel") });
    cancel.addEventListener("click", () => this.close());

    window.setTimeout(() => urlInput.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 仓库文件模糊选择器:选中后回调该 TFile(用于生成引用其相对路径的 link 卡片) */
export class VaultFilePickModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    themeClass: string,
    private files: TFile[],
    private onPick: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder(t("pickVaultFileTitle"));
    this.modalEl.addClass(themeClass);
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
