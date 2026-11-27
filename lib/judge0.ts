import http from "node:http";
import https from "node:https";
import { getLanguageConfig } from "@/lib/languages";
import type { ExecutionResult } from "@/types/execution";

const MAX_OUTPUT_CHARS = 65_536;

interface Judge0SubmissionResponse {
  token?: string;
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  exit_code?: number | null;
  exit_signal?: number | null;
  time?: string | null;
  memory?: number | null;
  status?: {
    id: number;
    description: string;
  };
}

function getJudge0BaseUrl(): string {
  return (process.env.JUDGE0_URL || "http://localhost:2358").replace(/\/+$/, "");
}

function decodeBase64(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf-8");
  } catch {
    return value;
  }
}

function stripAnsi(text: string): string {
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [output truncated at 64 KB]`;
}

function sanitizeSandboxOutput(raw: string): string {
  if (!raw) return "";
  const cleaned = stripAnsi(raw)
    .replace(/\/(?:tmp|judge|box|isolate)[^:\s]*\//g, "")
    .trimEnd();
  return truncateOutput(cleaned);
}

function requestJudge0Json(
  targetUrl: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 15000,
): Promise<{ statusCode: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const allowSelfSigned = process.env.JUDGE0_ALLOW_SELF_SIGNED === "true";

    const requestHeaders: Record<string, string> = { ...headers };
    if (body !== undefined) {
      requestHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
    }

    const req = transport.request(
      parsed,
      {
        method,
        headers: requestHeaders,
        ...(isHttps && allowSelfSigned ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            text: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Judge0 request timed out."));
    });
    req.on("error", reject);

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const authToken = process.env.JUDGE0_AUTH_TOKEN?.trim();
  if (authToken) {
    headers["X-Auth-Token"] = authToken;
  }
  return headers;
}

function buildErrorResult(language: string, message: string): ExecutionResult {
  return {
    ok: false,
    language,
    statusId: 0,
    statusDescription: "Execution Error",
    stdout: "",
    stderr: "",
    compileOutput: "",
    message: "",
    exitCode: null,
    exitSignal: null,
    time: null,
    memory: null,
    ranAt: new Date().toISOString(),
    error: message,
  };
}

export async function executeWithJudge0(params: {
  sourceCode: string;
  language: string;
  stdin: string;
}): Promise<ExecutionResult> {
  const config = getLanguageConfig(params.language);
  const baseUrl = getJudge0BaseUrl();
  const headers = buildHeaders();
  const submitUrl = `${baseUrl}/submissions?base64_encoded=true&wait=true`;

  const basePayload = {
    source_code: Buffer.from(params.sourceCode, "utf-8").toString("base64"),
    language_id: config.judge0Id,
    stdin: Buffer.from(params.stdin ?? "", "utf-8").toString("base64"),
    cpu_time_limit: 5,
    wall_time_limit: 10,
    memory_limit: 128000,
  };

  const hardenedPayload = JSON.stringify({
    ...basePayload,
    enable_network: false,
    max_processes_and_or_threads: 30,
    max_file_size: 1024,
  });

  let response: { statusCode: number; text: string };
  try {
    response = await requestJudge0Json(submitUrl, "POST", headers, hardenedPayload);
    // Some Judge0 instances forbid per-submission limit overrides with 422; fallback to base caps
    if (response.statusCode === 422) {
      response = await requestJudge0Json(
        submitUrl,
        "POST",
        headers,
        JSON.stringify(basePayload),
      );
    }
  } catch (err) {
    return buildErrorResult(
      config.id,
      err instanceof Error
        ? `Could not reach Judge0 (${err.message}).`
        : "Could not reach Judge0 server.",
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return buildErrorResult(
      config.id,
      `Judge0 returned HTTP ${response.statusCode}: ${response.text.slice(0, 300)}`,
    );
  }

  let data: Judge0SubmissionResponse;
  try {
    data = JSON.parse(response.text) as Judge0SubmissionResponse;
  } catch {
    return buildErrorResult(config.id, "Judge0 returned invalid JSON.");
  }

  if ((!data.status || data.status.id < 3) && data.token) {
    const submissionToken = data.token;
    const delays = [150, 300, 500, 800, 1000];
    for (let attempt = 0; attempt < 35; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, delays[Math.min(attempt, delays.length - 1)]),
      );

      let poll: { statusCode: number; text: string };
      try {
        poll = await requestJudge0Json(
          `${baseUrl}/submissions/${encodeURIComponent(submissionToken)}?base64_encoded=true`,
          "GET",
          headers,
        );
      } catch (err) {
        return buildErrorResult(
          config.id,
          err instanceof Error
            ? `Judge0 polling failed (${err.message}).`
            : "Judge0 polling failed.",
        );
      }

      if (poll.statusCode < 200 || poll.statusCode >= 300) {
        return buildErrorResult(
          config.id,
          `Judge0 poll error (${poll.statusCode}): ${poll.text.slice(0, 300)}`,
        );
      }

      data = JSON.parse(poll.text) as Judge0SubmissionResponse;
      if (data.status && data.status.id >= 3) {
        break;
      }
    }
  }

  if (!data.status || data.status.id < 3) {
    return buildErrorResult(config.id, "Timed out waiting for Judge0 execution.");
  }

  const stdout = truncateOutput(decodeBase64(data.stdout));
  const stderr = sanitizeSandboxOutput(decodeBase64(data.stderr));
  const compileOutput = sanitizeSandboxOutput(decodeBase64(data.compile_output));
  const message = sanitizeSandboxOutput(decodeBase64(data.message));

  return {
    ok: data.status.id === 3,
    language: config.id,
    statusId: data.status.id,
    statusDescription: data.status.description || "Completed",
    stdout,
    stderr,
    compileOutput,
    message,
    exitCode: data.exit_code ?? null,
    exitSignal: data.exit_signal ?? null,
    time: data.time ?? null,
    memory: data.memory ?? null,
    ranAt: new Date().toISOString(),
  };
}
