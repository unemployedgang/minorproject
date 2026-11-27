"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type * as MonacoNS from "monaco-editor";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { getLanguageConfig, SUPPORTED_LANGUAGES } from "@/lib/languages";
import { type MonacoApi, YMonacoBinding } from "@/lib/y-monaco-binding";

loader.config({ paths: { vs: "/monaco/vs" } });

const CURSOR_COLORS = [
  "#7c7ff5",
  "#22c55e",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#a855f7",
  "#14b8a6",
];

export function getParticipantColor(clientId: number): string {
  return CURSOR_COLORS[Math.abs(clientId) % CURSOR_COLORS.length];
}

interface RemoteCursorInfo {
  clientId: number;
  name: string;
  color: string;
  line: number | null;
  column: number | null;
}

interface CollaborativeEditorProps {
  doc: Y.Doc | null;
  awareness: Awareness | null;
  language: string;
  localName: string;
  isRunning: boolean;
  onLanguageChange: (languageId: string) => void;
  onRunCode: () => void;
}

function escapeCssContent(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

export default function CollaborativeEditor({
  doc,
  awareness,
  language,
  localName,
  isRunning,
  onLanguageChange,
  onRunCode,
}: CollaborativeEditorProps) {
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);
  const monacoApiRef = useRef<MonacoApi | null>(null);
  const bindingRef = useRef<YMonacoBinding | null>(null);
  const onRunRef = useRef(onRunCode);
  const [editorReady, setEditorReady] = useState(false);
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursorInfo[]>([]);

  onRunRef.current = onRunCode;

  const languageConfig = useMemo(() => getLanguageConfig(language), [language]);
  const localColor = useMemo(
    () => (doc ? getParticipantColor(doc.clientID) : CURSOR_COLORS[0]),
    [doc],
  );

  // Keep local awareness user metadata updated
  useEffect(() => {
    if (!awareness || !doc) return;
    awareness.setLocalStateField("user", {
      name: localName,
      color: getParticipantColor(doc.clientID),
    });
  }, [awareness, doc, localName]);

  // Bind Y.Text + Awareness to Monaco once both editor and Yjs doc are ready
  useEffect(() => {
    const editor = editorRef.current;
    const monacoApi = monacoApiRef.current;
    if (!editorReady || !editor || !monacoApi || !doc || !awareness) return;

    const model = editor.getModel();
    if (!model) return;

    const ytext = doc.getText("code");
    const binding = new YMonacoBinding(monacoApi, ytext, model, editor, awareness);
    bindingRef.current = binding;

    return () => {
      binding.destroy();
      bindingRef.current = null;
    };
  }, [editorReady, doc, awareness]);

  // Track remote cursors/selections for presence pills and dynamic cursor CSS
  useEffect(() => {
    if (!awareness || !doc) {
      setRemoteCursors([]);
      return;
    }

    const updateCursors = () => {
      const model = editorRef.current?.getModel();
      const ytext = doc.getText("code");
      const next: RemoteCursorInfo[] = [];

      awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.clientID) return;
        const user = state?.user as { name?: string; color?: string } | undefined;
        if (!user?.name) return;

        let line: number | null = null;
        let column: number | null = null;
        const sel = state?.selection as { head?: Y.RelativePosition } | undefined;
        if (sel?.head && model) {
          const abs = Y.createAbsolutePositionFromRelativePosition(sel.head, doc);
          if (abs && abs.type === ytext) {
            const pos = model.getPositionAt(abs.index);
            line = pos.lineNumber;
            column = pos.column;
          }
        }

        next.push({
          clientId,
          name: user.name,
          color: user.color || getParticipantColor(clientId),
          line,
          column,
        });
      });

      setRemoteCursors(next);
    };

    updateCursors();
    awareness.on("change", updateCursors);
    return () => {
      awareness.off("change", updateCursors);
    };
  }, [awareness, doc, editorReady]);

  const remoteCursorCss = useMemo(() => {
    return remoteCursors
      .map((peer) => {
        const label = escapeCssContent(peer.name);
        return `
          .yRemoteSelection-${peer.clientId} {
            background-color: ${peer.color}33;
            border-radius: 2px;
          }
          .yRemoteSelectionHead-${peer.clientId} {
            position: relative;
            display: inline-block;
            width: 0;
            border-left: 2px solid ${peer.color};
            box-sizing: border-box;
          }
          .yRemoteSelectionHead-${peer.clientId}::after {
            content: "${label}";
            position: absolute;
            top: -1.45em;
            left: -2px;
            background: ${peer.color};
            color: #0b0c10;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 10px;
            font-weight: 700;
            line-height: 1.25;
            padding: 1px 6px;
            border-radius: 4px 4px 4px 0;
            white-space: nowrap;
            pointer-events: none;
            z-index: 30;
            box-shadow: 0 2px 6px rgb(0 0 0 / 45%);
          }
        `;
      })
      .join("\n");
  }, [remoteCursors]);

  function handleEditorMount(
    editor: MonacoNS.editor.IStandaloneCodeEditor,
    monacoApi: MonacoApi,
  ) {
    editorRef.current = editor;
    monacoApiRef.current = monacoApi;
    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.Enter, () => {
      onRunRef.current();
    });
    setEditorReady(true);
  }

  return (
    <section className="editor-panel" aria-label="Collaborative code editor">
      {remoteCursorCss && <style>{remoteCursorCss}</style>}

      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          <label htmlFor="language-select" className="sr-only">
            Programming language
          </label>
          <select
            id="language-select"
            className="language-select"
            value={languageConfig.id}
            onChange={(event) => onLanguageChange(event.target.value)}
            disabled={!doc}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.id} value={lang.id}>
                {lang.label}
              </option>
            ))}
          </select>
          <span className="filename-badge">{languageConfig.filename}</span>
        </div>

        <div className="editor-presence">
          <span className="presence-pill" title="Your cursor color">
            <span className="presence-dot" style={{ backgroundColor: localColor }} />
            {localName} (you)
          </span>
          {remoteCursors.map((peer) => (
            <span
              key={peer.clientId}
              className="presence-pill"
              title={
                peer.line !== null
                  ? `${peer.name} at Ln ${peer.line}, Col ${peer.column}`
                  : peer.name
              }
            >
              <span className="presence-dot" style={{ backgroundColor: peer.color }} />
              {peer.name}
              {peer.line !== null && (
                <span className="presence-pos">
                  Ln {peer.line}:{peer.column}
                </span>
              )}
            </span>
          ))}
        </div>

        <div className="editor-toolbar-right">
          <button
            type="button"
            className="run-button"
            onClick={onRunCode}
            disabled={!doc || isRunning}
            title="Run code (Ctrl+Enter / Cmd+Enter)"
          >
            {isRunning ? "Running…" : "Run Code"}
          </button>
        </div>
      </div>

      <div className="monaco-wrapper">
        <Editor
          height="100%"
          theme="vs-dark"
          language={languageConfig.monacoLanguage}
          defaultValue=""
          onMount={handleEditorMount}
          options={{
            fontSize: 14,
            lineHeight: 22,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: "on",
            padding: { top: 22, bottom: 16 },
            cursorBlinking: "smooth",
            smoothScrolling: true,
            renderWhitespace: "selection",
          }}
        />
      </div>
    </section>
  );
}
