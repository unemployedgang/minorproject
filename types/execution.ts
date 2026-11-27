export interface ExecutionRequest {
  sourceCode: string;
  language: string;
  stdin: string;
}

export interface ExecutionResult {
  ok: boolean;
  language: string;
  statusId: number;
  statusDescription: string;
  stdout: string;
  stderr: string;
  compileOutput: string;
  message: string;
  exitCode: number | null;
  exitSignal: number | null;
  time: string | null;
  memory: number | null;
  ranAt: string;
  ranBy?: string;
  error?: string;
}
