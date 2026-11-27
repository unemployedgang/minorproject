import * as Y from "yjs";
import { createMutex } from "lib0/mutex";
import type * as MonacoNS from "monaco-editor";
import type { Awareness } from "y-protocols/awareness";

export type MonacoApi = typeof MonacoNS;

class RelativeSelection {
  constructor(
    public readonly start: Y.RelativePosition,
    public readonly end: Y.RelativePosition,
    public readonly direction: MonacoNS.SelectionDirection,
  ) {}
}

function normalizeLF(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function applyTextDiff(ytext: Y.Text, nextValue: string): void {
  const prevValue = ytext.toString();
  if (prevValue === nextValue) return;

  let start = 0;
  while (
    start < prevValue.length &&
    start < nextValue.length &&
    prevValue[start] === nextValue[start]
  ) {
    start++;
  }

  let prevEnd = prevValue.length;
  let nextEnd = nextValue.length;
  while (
    prevEnd > start &&
    nextEnd > start &&
    prevValue[prevEnd - 1] === nextValue[nextEnd - 1]
  ) {
    prevEnd--;
    nextEnd--;
  }

  const deleteCount = prevEnd - start;
  const insertText = nextValue.slice(start, nextEnd);
  if (deleteCount > 0) ytext.delete(start, deleteCount);
  if (insertText.length > 0) ytext.insert(start, insertText);
}

function createRelativeSelection(
  editor: MonacoNS.editor.IStandaloneCodeEditor,
  model: MonacoNS.editor.ITextModel,
  ytext: Y.Text,
): RelativeSelection | null {
  const sel = editor.getSelection();
  if (!sel) return null;
  const start = Y.createRelativePositionFromTypeIndex(
    ytext,
    model.getOffsetAt(sel.getStartPosition()),
  );
  const end = Y.createRelativePositionFromTypeIndex(
    ytext,
    model.getOffsetAt(sel.getEndPosition()),
  );
  return new RelativeSelection(start, end, sel.getDirection());
}

function createMonacoSelectionFromRelative(
  monacoApi: MonacoApi,
  model: MonacoNS.editor.ITextModel,
  ytext: Y.Text,
  relSel: RelativeSelection,
  doc: Y.Doc,
): MonacoNS.Selection | null {
  const start = Y.createAbsolutePositionFromRelativePosition(relSel.start, doc);
  const end = Y.createAbsolutePositionFromRelativePosition(relSel.end, doc);
  if (!start || !end || start.type !== ytext || end.type !== ytext) {
    return null;
  }
  const startPos = model.getPositionAt(start.index);
  const endPos = model.getPositionAt(end.index);
  return monacoApi.Selection.createWithDirection(
    startPos.lineNumber,
    startPos.column,
    endPos.lineNumber,
    endPos.column,
    relSel.direction,
  );
}

/**
 * Binds a Y.Text and Yjs Awareness instance to a Monaco editor instance,
 * enforcing LF line endings and keeping model <-> Y.Text strictly synchronized.
 */
export class YMonacoBinding {
  private readonly doc: Y.Doc;
  private readonly mux = createMutex();
  private savedSelection: RelativeSelection | null = null;
  private decorations: string[] = [];
  private readonly disposables: MonacoNS.IDisposable[] = [];

  constructor(
    private readonly monacoApi: MonacoApi,
    private readonly ytext: Y.Text,
    private readonly model: MonacoNS.editor.ITextModel,
    private readonly editor: MonacoNS.editor.IStandaloneCodeEditor,
    private readonly awareness: Awareness | null = null,
  ) {
    const doc = ytext.doc;
    if (!doc) {
      throw new Error("Y.Text must belong to a Y.Doc before binding to Monaco.");
    }
    this.doc = doc;

    // Force LF everywhere so Y.Text offsets and Monaco offsets always match 1:1
    model.setEOL(monacoApi.editor.EndOfLineSequence.LF);
    model.updateOptions({ trimAutoWhitespace: false });

    this.doc.on("beforeAllTransactions", this.handleBeforeTransactions);
    this.ytext.observe(this.handleYTextEvent);

    const initialValue = normalizeLF(ytext.toString());
    if (normalizeLF(model.getValue()) !== initialValue) {
      this.mux(() => {
        model.setValue(initialValue);
        model.setEOL(monacoApi.editor.EndOfLineSequence.LF);
      });
    }

    this.disposables.push(
      model.onDidChangeContent((event) => {
        this.mux(() => {
          if (model.getEOL() !== "\n") {
            model.setEOL(monacoApi.editor.EndOfLineSequence.LF);
          }

          this.doc.transact(() => {
            const sorted = [...event.changes].sort(
              (a, b) => b.rangeOffset - a.rangeOffset,
            );
            for (const change of sorted) {
              if (change.rangeLength > 0) {
                this.ytext.delete(change.rangeOffset, change.rangeLength);
              }
              const normalizedText = normalizeLF(change.text);
              if (normalizedText.length > 0) {
                this.ytext.insert(change.rangeOffset, normalizedText);
              }
            }

            // Self-heal if Monaco produced a multi-op edit or offset drift
            const modelValue = normalizeLF(model.getValue());
            if (this.ytext.toString() !== modelValue) {
              applyTextDiff(this.ytext, modelValue);
            }
          }, this);
        });
      }),
    );

    this.disposables.push(
      model.onWillDispose(() => {
        this.destroy();
      }),
    );

    if (this.awareness) {
      this.disposables.push(
        editor.onDidChangeCursorSelection(() => {
          if (editor.getModel() !== model) return;
          const sel = editor.getSelection();
          if (!sel) return;

          let anchor = model.getOffsetAt(sel.getStartPosition());
          let head = model.getOffsetAt(sel.getEndPosition());
          if (sel.getDirection() === monacoApi.SelectionDirection.RTL) {
            [anchor, head] = [head, anchor];
          }

          this.awareness?.setLocalStateField("selection", {
            anchor: Y.createRelativePositionFromTypeIndex(this.ytext, anchor),
            head: Y.createRelativePositionFromTypeIndex(this.ytext, head),
          });
        }),
      );
      this.awareness.on("change", this.rerenderDecorations);
      this.rerenderDecorations();
    }
  }

  private handleBeforeTransactions = (): void => {
    this.mux(() => {
      if (this.editor.getModel() === this.model) {
        this.savedSelection = createRelativeSelection(
          this.editor,
          this.model,
          this.ytext,
        );
      }
    });
  };

  private handleYTextEvent = (event: Y.YTextEvent): void => {
    this.mux(() => {
      let index = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) {
          index += op.retain;
        } else if (op.insert !== undefined) {
          const insertText = normalizeLF(String(op.insert));
          const pos = this.model.getPositionAt(index);
          const range = new this.monacoApi.Range(
            pos.lineNumber,
            pos.column,
            pos.lineNumber,
            pos.column,
          );
          this.model.applyEdits([{ range, text: insertText }]);
          index += insertText.length;
        } else if (op.delete !== undefined) {
          const startPos = this.model.getPositionAt(index);
          const endPos = this.model.getPositionAt(index + op.delete);
          const range = new this.monacoApi.Range(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column,
          );
          this.model.applyEdits([{ range, text: "" }]);
        }
      }

      // Guarantee Monaco's buffer matches authoritative Y.Text 1:1
      const authoritative = normalizeLF(this.ytext.toString());
      if (normalizeLF(this.model.getValue()) !== authoritative) {
        this.model.setValue(authoritative);
        this.model.setEOL(this.monacoApi.editor.EndOfLineSequence.LF);
      }

      if (this.savedSelection) {
        const restored = createMonacoSelectionFromRelative(
          this.monacoApi,
          this.model,
          this.ytext,
          this.savedSelection,
          this.doc,
        );
        if (restored) {
          this.editor.setSelection(restored);
        }
      }
    });

    this.rerenderDecorations();
  };

  private rerenderDecorations = (): void => {
    if (!this.awareness || this.editor.getModel() !== this.model) {
      this.decorations = this.editor.deltaDecorations(this.decorations, []);
      return;
    }

    const nextDecorations: MonacoNS.editor.IModelDeltaDecoration[] = [];
    this.awareness.getStates().forEach((state, clientID) => {
      if (clientID === this.doc.clientID) return;
      const sel = state?.selection as
        | { anchor?: Y.RelativePosition; head?: Y.RelativePosition }
        | undefined;
      if (!sel?.anchor || !sel?.head) return;

      const anchorAbs = Y.createAbsolutePositionFromRelativePosition(
        sel.anchor,
        this.doc,
      );
      const headAbs = Y.createAbsolutePositionFromRelativePosition(
        sel.head,
        this.doc,
      );
      if (
        !anchorAbs ||
        !headAbs ||
        anchorAbs.type !== this.ytext ||
        headAbs.type !== this.ytext
      ) {
        return;
      }

      let start: MonacoNS.IPosition;
      let end: MonacoNS.IPosition;
      let afterContentClassName: string | undefined;
      let beforeContentClassName: string | undefined;

      if (anchorAbs.index < headAbs.index) {
        start = this.model.getPositionAt(anchorAbs.index);
        end = this.model.getPositionAt(headAbs.index);
        afterContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`;
      } else {
        start = this.model.getPositionAt(headAbs.index);
        end = this.model.getPositionAt(anchorAbs.index);
        beforeContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`;
      }

      nextDecorations.push({
        range: new this.monacoApi.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        ),
        options: {
          className: `yRemoteSelection yRemoteSelection-${clientID}`,
          afterContentClassName,
          beforeContentClassName,
        },
      });
    });

    this.decorations = this.editor.deltaDecorations(
      this.decorations,
      nextDecorations,
    );
  };

  public destroy(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.ytext.unobserve(this.handleYTextEvent);
    this.doc.off("beforeAllTransactions", this.handleBeforeTransactions);
    if (this.awareness) {
      this.awareness.off("change", this.rerenderDecorations);
    }
    this.decorations = this.editor.deltaDecorations(this.decorations, []);
  }
}
