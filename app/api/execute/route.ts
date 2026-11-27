import { NextResponse } from "next/server";
import { executeWithJudge0 } from "@/lib/judge0";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

const MAX_CODE_BYTES = 100_000;
const MAX_STDIN_BYTES = 100_000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be an object." },
      { status: 400 },
    );
  }

  const { sourceCode, language, stdin } = body as Record<string, unknown>;

  if (typeof sourceCode !== "string" || !sourceCode.trim()) {
    return NextResponse.json(
      { error: "Source code cannot be empty." },
      { status: 400 },
    );
  }

  if (Buffer.byteLength(sourceCode, "utf-8") > MAX_CODE_BYTES) {
    return NextResponse.json(
      { error: "Source code exceeds the 100 KB limit." },
      { status: 413 },
    );
  }

  if (
    typeof language !== "string" ||
    !SUPPORTED_LANGUAGES.some((item) => item.id === language)
  ) {
    return NextResponse.json(
      { error: "Unsupported programming language." },
      { status: 400 },
    );
  }

  const normalizedStdin = typeof stdin === "string" ? stdin : "";
  if (Buffer.byteLength(normalizedStdin, "utf-8") > MAX_STDIN_BYTES) {
    return NextResponse.json(
      { error: "Standard input exceeds the 100 KB limit." },
      { status: 413 },
    );
  }

  const result = await executeWithJudge0({
    sourceCode,
    language,
    stdin: normalizedStdin,
  });

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
