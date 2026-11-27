"use client";

import type { ExecutionResult } from "@/types/execution";

interface ExecutionPanelProps {
  stdin: string;
  onStdinChange: (value: string) => void;
  result: ExecutionResult | null;
  isRunning: boolean;
  runningBy: string | null;
  onClearOutput: () => void;
}

function formatMemory(memoryKb: number | null): string | null {
  if (memoryKb === null || memoryKb === undefined) return null;
  if (memoryKb >= 1024) {
    return `${(memoryKb / 1024).toFixed(1)} MB`;
  }
  return `${memoryKb} KB`;
}

function formatTime(timeSec: string | null): string | null {
  if (!timeSec) return null;
  const parsed = Number.parseFloat(timeSec);
  if (Number.isNaN(parsed)) return null;
  return `${Math.round(parsed * 1000)} ms`;
}

function getStatusVariant(result: ExecutionResult | null, isRunning: boolean): string {
  if (isRunning) return "running";
  if (!result) return "idle";
  if (result.error || result.statusId >= 5 || result.statusId === 0) return "error";
  if (result.statusId === 3) return "success";
  return "neutral";
}

export default function ExecutionPanel({
  stdin,
  onStdinChange,
  result,
  isRunning,
  runningBy,
  onClearOutput,
}: ExecutionPanelProps) {
  const statusVariant = getStatusVariant(result, isRunning);
  const timeLabel = result ? formatTime(result.time) : null;
  const memoryLabel = result ? formatMemory(result.memory) : null;

  const hasAnyOutput =
    result &&
    Boolean(
      result.error ||
        result.compileOutput ||
        result.stdout ||
        result.stderr ||
        result.message,
    );

  return (
    <section className="io-panel" aria-label="Program input and output">
      <div className="io-stdin-pane">
        <div className="io-pane-header">
          <span>INPUT (stdin)</span>
          {stdin.length > 0 && (
            <button
              type="button"
              className="io-link-button"
              onClick={() => onStdinChange("")}
            >
              Clear
            </button>
          )}
        </div>
        <textarea
          className="io-stdin-textarea"
          value={stdin}
          onChange={(event) => onStdinChange(event.target.value)}
          placeholder="Enter stdin test input here (synced with peer)…"
          spellCheck={false}
        />
      </div>

      <div className="io-output-pane">
        <div className="io-pane-header">
          <div className="io-status-group">
            <span>TERMINAL OUTPUT</span>
            {isRunning && (
              <span className={`io-status-badge ${statusVariant}`}>
                Running{runningBy ? ` (${runningBy})` : ""}…
              </span>
            )}
            {!isRunning && result && (
              <span className={`io-status-badge ${statusVariant}`}>
                {result.statusDescription}
              </span>
            )}
          </div>

          <div className="io-meta-group">
            {!isRunning && result?.ranBy && (
              <span className="io-meta-item">By {result.ranBy}</span>
            )}
            {!isRunning && result?.exitCode !== null && result?.exitCode !== undefined && (
              <span className="io-meta-item">Exit {result.exitCode}</span>
            )}
            {!isRunning && timeLabel && <span className="io-meta-item">{timeLabel}</span>}
            {!isRunning && memoryLabel && <span className="io-meta-item">{memoryLabel}</span>}
            {result && !isRunning && (
              <button
                type="button"
                className="io-link-button"
                onClick={onClearOutput}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="io-terminal-body">
          {!result && !isRunning && (
            <p className="io-placeholder">
              Click <strong>Run Code</strong> (or press Ctrl+Enter / Cmd+Enter) to execute in the Judge0 sandbox.
            </p>
          )}

          {isRunning && !result && (
            <p className="io-placeholder">Executing code in sandbox…</p>
          )}

          {result?.error && (
            <div className="io-stream-block">
              <div className="io-stream-label error">Error</div>
              <pre className="io-stream-pre error">{result.error}</pre>
            </div>
          )}

          {result?.compileOutput && (
            <div className="io-stream-block">
              <div className="io-stream-label error">Compiler Output</div>
              <pre className="io-stream-pre error">{result.compileOutput}</pre>
            </div>
          )}

          {result?.stdout && (
            <div className="io-stream-block">
              <div className="io-stream-label">stdout</div>
              <pre className="io-stream-pre">{result.stdout}</pre>
            </div>
          )}

          {result?.stderr && (
            <div className="io-stream-block">
              <div className="io-stream-label error">stderr</div>
              <pre className="io-stream-pre error">{result.stderr}</pre>
            </div>
          )}

          {result?.message && (
            <div className="io-stream-block">
              <div className="io-stream-label warn">System Message</div>
              <pre className="io-stream-pre warn">{result.message}</pre>
            </div>
          )}

          {result && !hasAnyOutput && !isRunning && (
            <p className="io-placeholder">(Program exited with no output)</p>
          )}
        </div>
      </div>
    </section>
  );
}
