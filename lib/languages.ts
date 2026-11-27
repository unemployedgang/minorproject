export interface LanguageConfig {
  id: string;
  label: string;
  judge0Id: number;
  monacoLanguage: string;
  filename: string;
  starterCode: string;
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  {
    id: "python",
    label: "Python 3",
    judge0Id: 71,
    monacoLanguage: "python",
    filename: "main.py",
    starterCode: `import sys

def solve():
    data = sys.stdin.read().strip()
    if data:
        print(f"Input received: {data}")
    else:
        print("Hello from Python 3!")

if __name__ == "__main__":
    solve()
`,
  },
  {
    id: "cpp",
    label: "C++ (GCC)",
    judge0Id: 54,
    monacoLanguage: "cpp",
    filename: "main.cpp",
    starterCode: `#include <iostream>
#include <string>

using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    string line;
    if (getline(cin, line) && !line.empty()) {
        cout << "Input received: " << line << "\\n";
    } else {
        cout << "Hello from C++!\\n";
    }
    return 0;
}
`,
  },
  {
    id: "c",
    label: "C (GCC)",
    judge0Id: 50,
    monacoLanguage: "c",
    filename: "main.c",
    starterCode: `#include <stdio.h>

int main(void) {
    char buffer[256];
    if (fgets(buffer, sizeof(buffer), stdin) != NULL) {
        printf("Input received: %s", buffer);
    } else {
        printf("Hello from C!\\n");
    }
    return 0;
}
`,
  },
  {
    id: "java",
    label: "Java",
    judge0Id: 62,
    monacoLanguage: "java",
    filename: "Main.java",
    starterCode: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        if (sc.hasNextLine()) {
            System.out.println("Input received: " + sc.nextLine());
        } else {
            System.out.println("Hello from Java!");
        }
    }
}
`,
  },
  {
    id: "javascript",
    label: "JavaScript (Node.js)",
    judge0Id: 63,
    monacoLanguage: "javascript",
    filename: "main.js",
    starterCode: `const fs = require("fs");

const input = fs.readFileSync(0, "utf8").trim();
if (input) {
  console.log("Input received:", input);
} else {
  console.log("Hello from Node.js!");
}
`,
  },
  {
    id: "typescript",
    label: "TypeScript",
    judge0Id: 74,
    monacoLanguage: "typescript",
    filename: "main.ts",
    starterCode: `import * as fs from "fs";

const input: string = fs.readFileSync(0, "utf8").trim();
if (input) {
  console.log(\`Input received: \${input}\`);
} else {
  console.log("Hello from TypeScript!");
}
`,
  },
  {
    id: "go",
    label: "Go",
    judge0Id: 60,
    monacoLanguage: "go",
    filename: "main.go",
    starterCode: `package main

import (
\t"bufio"
\t"fmt"
\t"os"
)

func main() {
\tscanner := bufio.NewScanner(os.Stdin)
\tif scanner.Scan() && scanner.Text() != "" {
\t\tfmt.Println("Input received:", scanner.Text())
\t} else {
\t\tfmt.Println("Hello from Go!")
\t}
}
`,
  },
  {
    id: "rust",
    label: "Rust",
    judge0Id: 73,
    monacoLanguage: "rust",
    filename: "main.rs",
    starterCode: `use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    let _ = io::stdin().read_to_string(&mut input);
    let trimmed = input.trim();
    if !trimmed.is_empty() {
        println!("Input received: {}", trimmed);
    } else {
        println!("Hello from Rust!");
    }
}
`,
  },
];

export const DEFAULT_LANGUAGE_ID = "python";

export function getLanguageConfig(languageId: string): LanguageConfig {
  return (
    SUPPORTED_LANGUAGES.find((lang) => lang.id === languageId) ??
    SUPPORTED_LANGUAGES[0]
  );
}

export function isStarterTemplate(code: string): boolean {
  const normalized = code.trim();
  if (!normalized) return true;
  return SUPPORTED_LANGUAGES.some((lang) => lang.starterCode.trim() === normalized);
}
